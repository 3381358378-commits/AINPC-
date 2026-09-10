# -*- coding: utf-8 -*-
"""
赵佗小程序后端：阿里云 DashScope CosyVoice TTS 代理
终极稳定版：彻底废除 Chunked 流式传输，解决微信 Windows 客户端 wx.downloadFile 文件损坏问题。
"""
from flask import Flask, request, Response
from flask_cors import CORS
import hashlib, os, time, requests, threading, re
from collections import OrderedDict

# ========== 阿里云 DashScope CosyVoice 配置 ==========
DASHSCOPE_API_KEY = os.environ.get("DASHSCOPE_API_KEY", "YOUR_DASHSCOPE_API_KEY_HERE")
DASHSCOPE_API_HOST = "ws-xo32obunndyufg81.cn-beijing.maas.aliyuncs.com"
TTS_MODEL = "cosyvoice-v3-flash"
TTS_VOICE = "longsanshu_v3"
TTS_FORMAT = "mp3"
TTS_SAMPLE_RATE = 24000
TTS_API_URL = f"https://{DASHSCOPE_API_HOST}/api/v1/services/audio/tts/SpeechSynthesizer"

app = Flask(__name__)
CORS(app)

CACHE_DIR = os.path.join(os.path.dirname(__file__), "tts_cache")
os.makedirs(CACHE_DIR, exist_ok=True)

_memory_cache = OrderedDict()
_memory_cache_lock = threading.Lock()
_MEMORY_CACHE_MAX = 50

def _mem_get(key):
    with _memory_cache_lock:
        if key in _memory_cache:
            _memory_cache.move_to_end(key)
            return _memory_cache[key]
    return None

def _mem_put(key, data):
    with _memory_cache_lock:
        if key in _memory_cache:
            _memory_cache.move_to_end(key)
            return
        if len(_memory_cache) >= _MEMORY_CACHE_MAX:
            _memory_cache.popitem(last=False)
        _memory_cache[key] = data

def _clean_text_for_tts(text: str) -> str:
    """终极文本净化：移除大模型生成的所有特殊符号，防止音频引擎卡死"""
    if not text:
        return ""
    # 强制把【】和双引号替换为逗号，防止破坏语音连贯性
    text = text.replace('【', '，').replace('】', '，')
    text = text.replace('"', '').replace("'", "")
    text = re.sub(r'\*+', '', text)
    text = re.sub(r'#+\s*', '', text)
    text = re.sub(r'[\`\~\|]', '', text)
    text = re.sub(r'\[系统.*?\]', '', text)
    text = re.sub(r'\n+', '，', text)
    text = re.sub(r'，+', '，', text) # 合并多余的连续逗号
    return text.strip()

def _is_valid_audio(data: bytes) -> bool:
    """严格验证音频合法性，拒绝缓存报错的 XML 或微型文件"""
    if not data or len(data) < 1000:
        return False
    head = data[:100].lstrip()
    if head.startswith((b"<", b"{", b"[", b"<!")):
        return False
    if b"Error" in head or b"Exception" in head or b"Message" in head:
        return False
    return True

# 云端 CosyVoice 调用：提交文本任务后下载完整 MP3，交给缓存和 HTTP 响应层处理。
def _call_cosyvoice(text: str) -> bytes:
    """强制使用完整的 REST 请求获取纯正 MP3，不使用 websocket 流式"""
    payload = {
        "model": TTS_MODEL,
        "input": {
            "text": text
        },
        "parameters": {
            "voice": TTS_VOICE,
            "format": TTS_FORMAT,
            "sample_rate": TTS_SAMPLE_RATE,
        }
    }
    headers = {
        "Authorization": f"Bearer {DASHSCOPE_API_KEY}",
        "Content-Type": "application/json"
    }
    r = requests.post(TTS_API_URL, json=payload, headers=headers, timeout=60)
    if r.status_code != 200:
        raise RuntimeError(f"TTS submit failed HTTP {r.status_code}")
    
    audio_url = ((r.json().get("output") or {}).get("audio") or {}).get("url")
    if not audio_url:
        raise RuntimeError("Missing audio_url")
    
    ar = requests.get(audio_url, timeout=60)
    if ar.status_code != 200:
        raise RuntimeError(f"Audio download failed HTTP {ar.status_code}")
    
    # 坏文件拦截器：拒绝云端错误 XML/JSON 或过小响应，避免污染缓存并传给小程序。
    audio_data = ar.content
    if not _is_valid_audio(audio_data):
        raise RuntimeError(f"API返回了非音频数据(大小:{len(audio_data)}). 已拦截.")
    
    return audio_data


def handle_tts_request():
    """统一处理引擎，无论是 /tts 还是 /tts-stream 都走这个完整文件生成逻辑"""
    t0 = time.time()
    text = (request.json or {}).get("text", "").strip() if request.method == "POST" else request.args.get("text", "").strip()

    if not text:
        return Response("empty text", status=400)

    text = _clean_text_for_tts(text)
    if len(text) > 400: text = text[:400]

    cache_key = hashlib.md5(text.encode("utf-8")).hexdigest()

    # 1. 读内存缓存
    mem_data = _mem_get(cache_key)
    if mem_data is not None:
        if _is_valid_audio(mem_data):
            return _send_bytes(mem_data, cache_hit="mem", elapsed=time.time() - t0)
        else:
            with _memory_cache_lock: _memory_cache.pop(cache_key, None)

    # 2. 读文件缓存（try/except 防止并发竞态：exists=True 但 open 时文件已被删）
    cache_path = os.path.join(CACHE_DIR, cache_key + ".mp3")
    if os.path.exists(cache_path):
        try:
            with open(cache_path, "rb") as f:
                data = f.read()
            if _is_valid_audio(data):
                _mem_put(cache_key, data)
                return _send_bytes(data, cache_hit="disk", elapsed=time.time() - t0)
            else:
                try: os.remove(cache_path)
                except: pass
        except FileNotFoundError:
            pass  # 文件已被其他请求删除，继续走 API 生成

    # 3. 重新向 API 请求生成完整音频
    try:
        audio_bytes = _call_cosyvoice(text)
    except Exception as e:
        print(f"[TTS] 生成失败 ({time.time() - t0:.3f}s): {e}")
        return Response(f"tts error: {e}", status=500, mimetype="text/plain; charset=utf-8")

    _mem_put(cache_key, audio_bytes)
    with open(cache_path, "wb") as f:
        f.write(audio_bytes)

    print(f"[TTS] 成功生成并发送 ({time.time() - t0:.3f}s): {text[:30]}...")
    return _send_bytes(audio_bytes, cache_hit="miss", elapsed=time.time() - t0)

def _send_bytes(data, cache_hit="miss", elapsed=0):
    resp = Response(data, mimetype="audio/mpeg")
    resp.headers["Accept-Ranges"] = "bytes"
    # Content-Length 是解决微信 Windows 端报错的核心！告诉微信文件到底有多大，不要乱拼包。
    resp.headers["Content-Length"] = str(len(data))
    resp.headers["Cache-Control"] = "public, max-age=31536000"
    resp.headers["X-TTS-Cache"] = cache_hit
    resp.headers["X-TTS-Time"] = f"{elapsed:.3f}s"
    return resp

# ====== HTTP 路由：两个兼容入口统一返回完整 MP3，不使用分块流式传输 ======
@app.route("/tts", methods=["POST", "GET"])
def tts_normal():
    # 普通 TTS 入口，统一交给缓存、云端生成和 Content-Length 返回链路。
    return handle_tts_request()

@app.route("/tts-stream", methods=["POST", "GET"])
def tts_stream():
    # 虽然前端请求的是 stream 接口，但我们强制返回完整的文件包，避免 wx.downloadFile 崩溃
    return handle_tts_request()


@app.route("/health", methods=["GET"])
def health():
    return {"ok": True, "ts": int(time.time()), "provider": "aliyun-cosyvoice",
            "model": TTS_MODEL, "voice": TTS_VOICE}

if __name__ == "__main__":
    print("赵佗 TTS 后端启动 (阿里云 CosyVoice): http://127.0.0.1:5006")
    print("✅ 已彻底解决微信电脑端 wx.downloadFile 导致的文件损坏问题！")
    app.run(host="0.0.0.0", port=5006, debug=False, threaded=True)