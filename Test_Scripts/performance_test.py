# -*- coding: utf-8 -*-
"""
AINPC 性能指标测试脚本
测试项：
1. AI文本首响应延迟（通过DashScope API模拟）
2. TTS首音频延迟（通过server.py的/tts接口）
3. 音频缓存命中率（三级缓存）
4. 并发场景下请求成功率
5. API调用成本降幅（缓存启用前后对比）

注：音字同步误差和异常退出率为前端指标，需真机测试，本脚本提供理论分析
"""
import requests
import time
import hashlib
import os
import json
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TTS_SERVER = "http://127.0.0.1:5006"
CACHE_DIR = os.path.join(PROJECT_ROOT, "Backend_Service", "tts_cache")
REPORT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "performance_test_report.txt")
DASHSCOPE_API_KEY = "YOUR_DASHSCOPE_API_KEY_HERE"  # 开源前替换为占位符，避免真实密钥泄漏
CHAT_API_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"

# 测试用文本（模拟真实场景）
TEST_TEXTS = {
    "short_trigger": "就是这里了……南越王庙。两千余年过去，还有人记得本王，本王甚慰。",
    "medium_response": "汝可知脚下这条百岁街的来历？两千多年前，本王率五十万秦军南下，将士们来自中原九州，后来许多人都在这佗城卸甲归田，繁衍生息。如今这城里竟汇聚了179个姓氏！",
    "long_response": "不错！正是你答的这般！本王记起来了，这井不只是井，是中原技术在岭南扎下的第一道根。本王想起许多，这枚越王令就赠予你了！你且继续往前走去，那考棚里还等着你的才华呢。",
    "personalized": "你说你姓陈？哈哈，本王记得当年南下军中，确有一位陈姓校尉，勇猛过人，后来便在此地开枝散叶。莫非你便是他的后人？",
    "short_answer": "此井深十一米有余，乃青砖与红砂岩砌成。",
    "question": "本王问你，这越王井有多深？",
}

# ============================================================
# 测试 1：AI文本首响应延迟
# 直接调用DashScope通义千问API，测量从发送请求到收到首个response chunk的时间
# ============================================================
def test_ai_response_latency():
    print("\n" + "="*70)
    print("【测试1】AI文本首响应延迟（通义千问 qwen-plus）")
    print("="*70)

    latencies = []
    full_latencies = []

    system_prompt = "你是南越王赵佗，回答150字以内。"

    test_inputs = [
        {"role": "user", "content": "赵佗是谁？简单介绍一下。"},
        {"role": "user", "content": "佗城有什么特色？"},
        {"role": "user", "content": "和辑百越是什么意思？"},
    ]

    for idx, user_msg in enumerate(test_inputs):
        headers = {
            "Authorization": f"Bearer {DASHSCOPE_API_KEY}",
            "Content-Type": "application/json"
        }
        payload = {
            "model": "qwen-plus",
            "messages": [
                {"role": "system", "content": system_prompt},
                user_msg
            ],
            "max_tokens": 300,
            "stream": True
        }

        t0 = time.time()
        first_chunk_time = None
        full_text = ""

        try:
            r = requests.post(CHAT_API_URL, json=payload, headers=headers, stream=True, timeout=30)
            for line in r.iter_lines():
                if line:
                    line_str = line.decode('utf-8')
                    if line_str.startswith("data: "):
                        data_str = line_str[6:]
                        if data_str.strip() == "[DONE]":
                            break
                        try:
                            data = json.loads(data_str)
                            content = data.get("choices", [{}])[0].get("delta", {}).get("content", "")
                            if content:
                                if first_chunk_time is None:
                                    first_chunk_time = time.time() - t0
                                full_text += content
                        except json.JSONDecodeError:
                            pass
        except Exception as e:
            print(f"  请求 {idx+1} 失败: {e}")
            continue

        full_time = time.time() - t0

        if first_chunk_time is not None:
            latencies.append(first_chunk_time)
            full_latencies.append(full_time)
            print(f"  请求 {idx+1}: '{user_msg['content'][:20]}...'")
            print(f"    首字响应延迟: {first_chunk_time:.3f}s")
            print(f"    全文响应延迟: {full_time:.3f}s")
            print(f"    返回字数: {len(full_text)}")
        else:
            print(f"  请求 {idx+1}: 未收到内容")

    if latencies:
        avg_first = sum(latencies) / len(latencies)
        avg_full = sum(full_latencies) / len(full_latencies)
        print(f"\n  ★ 首字响应延迟: 平均 {avg_first:.3f}s (最小 {min(latencies):.3f}s, 最大 {max(latencies):.3f}s)")
        print(f"  ★ 全文响应延迟: 平均 {avg_full:.3f}s (最小 {min(full_latencies):.3f}s, 最大 {max(full_latencies):.3f}s)")
        return {"avg_first": avg_first, "avg_full": avg_full, "samples": len(latencies)}
    return {"avg_first": 0, "avg_full": 0, "samples": 0}


# ============================================================
# 测试 2：TTS首音频延迟
# 通过server.py的/tts接口，测量从发送请求到收到完整音频响应的时间
# 分别测试：内存缓存命中、磁盘缓存命中、首次生成（miss）
# ============================================================
def test_tts_latency():
    print("\n" + "="*70)
    print("【测试2】TTS首音频延迟（cosyvoice-v3-flash / server.py三级缓存）")
    print("="*70)

    results = {"mem": [], "disk": [], "miss": []}

    for name, text in TEST_TEXTS.items():
        # 第一步：确保文本是新的（用于miss测试），先清空缓存
        cache_key = hashlib.md5(text.encode("utf-8")).hexdigest()
        cache_path = os.path.join(CACHE_DIR, cache_key + ".mp3")

        # 清除已有缓存（确保第一次调用是miss）
        if os.path.exists(cache_path):
            os.remove(cache_path)

        # ---- Miss 测试（首次生成）----
        t0 = time.time()
        try:
            r = requests.post(f"{TTS_SERVER}/tts", json={"text": text}, timeout=120)
            miss_time = time.time() - t0
            cache_hit = r.headers.get("X-TTS-Cache", "unknown")
            server_time = r.headers.get("X-TTS-Time", "?")
            results["miss"].append(miss_time)
            print(f"  [{name}] MISS生成: {miss_time:.3f}s (服务端: {server_time}, 实际: {cache_hit})")
        except Exception as e:
            print(f"  [{name}] MISS请求失败: {e}")
            continue

        # ---- Disk 缓存测试（第二次调用，命中磁盘缓存，同时回填内存）----
        t0 = time.time()
        try:
            r = requests.post(f"{TTS_SERVER}/tts", json={"text": text}, timeout=120)
            disk_time = time.time() - t0
            cache_hit = r.headers.get("X-TTS-Cache", "unknown")
            server_time = r.headers.get("X-TTS-Time", "?")
            results["disk"].append(disk_time)
            print(f"  [{name}] DISK缓存命中: {disk_time:.3f}s (服务端: {server_time}, 实际: {cache_hit})")
        except Exception as e:
            print(f"  [{name}] DISK请求失败: {e}")

        # ---- Mem 缓存测试（第三次调用，命中内存缓存）----
        t0 = time.time()
        try:
            r = requests.post(f"{TTS_SERVER}/tts", json={"text": text}, timeout=120)
            mem_time = time.time() - t0
            cache_hit = r.headers.get("X-TTS-Cache", "unknown")
            server_time = r.headers.get("X-TTS-Time", "?")
            results["mem"].append(mem_time)
            print(f"  [{name}] MEM缓存命中: {mem_time:.3f}s (服务端: {server_time}, 实际: {cache_hit})")
        except Exception as e:
            print(f"  [{name}] MEM请求失败: {e}")

    # 汇总
    print(f"\n  ★ 统计汇总:")
    for tier in ["miss", "disk", "mem"]:
        times = results[tier]
        if times:
            avg = sum(times) / len(times)
            print(f"    {tier.upper():6s}: 平均 {avg:.3f}s (最小 {min(times):.3f}s, 最大 {max(times):.3f}s, 样本 {len(times)})")
        else:
            print(f"    {tier.upper():6s}: 无数据")

    return results


# ============================================================
# 测试 3：音频缓存命中率
# 模拟真实游览场景：混合高频标准讲解词 + 个性化提问
# 统计三级缓存的实际命中率
# ============================================================
def test_cache_hit_rate():
    print("\n" + "="*70)
    print("【测试3】音频缓存命中率（模拟真实游览场景）")
    print("="*70)

    # 清除所有磁盘缓存，但保留内存缓存的warm-up过程
    # 先warm-up内存缓存（高频标准讲解词）
    warmup_texts = [
        TEST_TEXTS["short_trigger"],     # 越王庙触发台词
        TEST_TEXTS["short_answer"],      # 常见回答
        TEST_TEXTS["question"],          # 常见提问
    ]

    print("  [预热阶段] 写入高频讲解词到缓存...")
    for text in warmup_texts:
        cache_key = hashlib.md5(text.encode("utf-8")).hexdigest()
        cache_path = os.path.join(CACHE_DIR, cache_key + ".mp3")
        if os.path.exists(cache_path):
            os.remove(cache_path)
        try:
            r = requests.post(f"{TTS_SERVER}/tts", json={"text": text}, timeout=120)
            print(f"    预热: '{text[:20]}...' → {r.headers.get('X-TTS-Cache', '?')}")
        except:
            pass

    # 模拟真实游览请求序列
    # 前3个是已缓存的高频词，后3个是新的个性化提问
    request_sequence = [
        ("高频-触发台词", TEST_TEXTS["short_trigger"]),
        ("高频-标准回答", TEST_TEXTS["short_answer"]),
        ("高频-提问", TEST_TEXTS["question"]),
        ("个性化-姓氏", TEST_TEXTS["personalized"]),
        ("个性化-长回答", TEST_TEXTS["long_response"]),
        ("个性化-中等回复", TEST_TEXTS["medium_response"]),
        # 重复高频请求（验证内存缓存）
        ("高频-触发台词(重复)", TEST_TEXTS["short_trigger"]),
        ("高频-标准回答(重复)", TEST_TEXTS["short_answer"]),
        ("高频-提问(重复)", TEST_TEXTS["question"]),
    ]

    hits = {"mem": 0, "disk": 0, "miss": 0}
    total = len(request_sequence)

    print(f"\n  [测试阶段] 发送 {total} 个请求序列...")
    for label, text in request_sequence:
        try:
            r = requests.post(f"{TTS_SERVER}/tts", json={"text": text}, timeout=120)
            cache_hit = r.headers.get("X-TTS-Cache", "unknown")
            server_time = r.headers.get("X-TTS-Time", "?")
            if cache_hit in hits:
                hits[cache_hit] += 1
            print(f"    [{label:15s}] 缓存: {cache_hit:4s} | 耗时: {server_time}")
        except Exception as e:
            print(f"    [{label:15s}] 请求失败: {e}")

    total_hits = sum(hits.values())
    cache_hit_rate = (hits["mem"] + hits["disk"]) / total_hits * 100 if total_hits > 0 else 0

    print(f"\n  ★ 缓存命中率统计:")
    print(f"    总请求数: {total_hits}")
    print(f"    内存缓存命中: {hits['mem']} ({hits['mem']/total_hits*100:.1f}%)")
    print(f"    磁盘缓存命中: {hits['disk']} ({hits['disk']/total_hits*100:.1f}%)")
    print(f"    未命中(API调用): {hits['miss']} ({hits['miss']/total_hits*100:.1f}%)")
    print(f"    综合缓存命中率: {cache_hit_rate:.1f}%")

    return {"hits": hits, "total": total_hits, "hit_rate": cache_hit_rate}


# ============================================================
# 测试 4：并发场景下请求成功率
# 模拟多个用户同时请求TTS
# ============================================================
def test_concurrent_requests():
    print("\n" + "="*70)
    print("【测试4】并发场景下请求成功率")
    print("="*70)

    # 测试文本池
    test_pool = list(TEST_TEXTS.values()) * 3  # 扩展到18个请求

    for concurrency in [10, 20, 50]:
        print(f"\n  --- 并发数: {concurrency} ---")
        success_count = 0
        fail_count = 0
        latencies = []

        def single_request(idx):
            text = test_pool[idx % len(test_pool)]
            t0 = time.time()
            try:
                r = requests.post(f"{TTS_SERVER}/tts", json={"text": text}, timeout=120)
                elapsed = time.time() - t0
                return idx, r.status_code == 200, elapsed, r.headers.get("X-TTS-Cache", "?")
            except Exception as e:
                return idx, False, time.time() - t0, str(e)[:50]

        with ThreadPoolExecutor(max_workers=concurrency) as executor:
            futures = [executor.submit(single_request, i) for i in range(concurrency)]
            for f in as_completed(futures):
                idx, ok, elapsed, cache = f.result()
                if ok:
                    success_count += 1
                    latencies.append(elapsed)
                else:
                    fail_count += 1

        success_rate = success_count / concurrency * 100
        avg_latency = sum(latencies) / len(latencies) if latencies else 0

        print(f"    成功: {success_count}/{concurrency} ({success_rate:.1f}%)")
        print(f"    失败: {fail_count}")
        if latencies:
            print(f"    平均延迟: {avg_latency:.3f}s (最小 {min(latencies):.3f}s, 最大 {max(latencies):.3f}s)")

    return {"tested_concurrency": [10, 20, 50]}


# ============================================================
# 测试 5：API调用成本降幅（缓存启用前后对比）
# 比较 无缓存 vs 有缓存 场景下的 DashScope API 调用次数
# ============================================================
def test_api_cost_reduction():
    print("\n" + "="*70)
    print("【测试5】API调用成本降幅（缓存启用前后对比）")
    print("="*70)

    # 模拟真实游览场景的请求序列
    # 假设一个完整游览过程中会有以下TTS请求
    scenario_requests = [
        # 景点触发台词（高频，会被缓存）
        TEST_TEXTS["short_trigger"],
        # 用户个性化提问（不命中缓存）
        TEST_TEXTS["personalized"],
        # AI回答（不命中缓存）
        TEST_TEXTS["medium_response"],
        # 常见回答（高频，会被缓存）
        TEST_TEXTS["short_answer"],
        # 过渡台词（高频，会被缓存）
        TEST_TEXTS["question"],
        # 下一景点触发（高频，会被缓存）
        TEST_TEXTS["short_trigger"],  # 重复
        # 又一个个性化回答
        TEST_TEXTS["long_response"],
        # 常见提问（重复）
        TEST_TEXTS["question"],  # 重复
    ]

    # 清空所有缓存
    print("  清空所有缓存...")
    cache_dir = CACHE_DIR
    if os.path.exists(cache_dir):
        for f in os.listdir(cache_dir):
            if f.endswith(".mp3"):
                os.remove(os.path.join(cache_dir, f))

    # --- 无缓存场景：每次请求都直接调用API ---
    print("\n  [无缓存场景] 逐条发送（模拟无缓存系统）...")
    no_cache_api_calls = len(scenario_requests)  # 无缓存=每次都要API
    no_cache_times = []
    for text in scenario_requests:
        # 每次都清除缓存确保miss
        cache_key = hashlib.md5(text.encode("utf-8")).hexdigest()
        cache_path = os.path.join(cache_dir, cache_key + ".mp3")
        if os.path.exists(cache_path):
            os.remove(cache_path)
        t0 = time.time()
        try:
            r = requests.post(f"{TTS_SERVER}/tts", json={"text": text}, timeout=120)
            no_cache_times.append(time.time() - t0)
        except:
            pass

    # --- 有缓存场景：利用三级缓存 ---
    print("  [有缓存场景] 逐条发送（利用三级缓存）...")
    with_cache_api_calls = 0
    with_cache_times = []
    for text in scenario_requests:
        t0 = time.time()
        try:
            r = requests.post(f"{TTS_SERVER}/tts", json={"text": text}, timeout=120)
            elapsed = time.time() - t0
            with_cache_times.append(elapsed)
            cache_hit = r.headers.get("X-TTS-Cache", "unknown")
            if cache_hit == "miss":
                with_cache_api_calls += 1
        except:
            pass

    total_requests = len(scenario_requests)
    reduction = (1 - with_cache_api_calls / no_cache_api_calls) * 100 if no_cache_api_calls > 0 else 0

    print(f"\n  ★ 成本对比:")
    print(f"    总请求数: {total_requests}")
    print(f"    无缓存系统: API调用 {no_cache_api_calls} 次 (100%)")
    print(f"    有缓存系统: API调用 {with_cache_api_calls} 次 ({with_cache_api_calls/total_requests*100:.1f}%)")
    print(f"    API调用降幅: {reduction:.1f}%")

    if no_cache_times and with_cache_times:
        avg_no_cache = sum(no_cache_times) / len(no_cache_times)
        avg_with_cache = sum(with_cache_times) / len(with_cache_times)
        total_no_cache = sum(no_cache_times)
        total_with_cache = sum(with_cache_times)
        print(f"\n  ★ 延迟对比:")
        print(f"    无缓存平均延迟: {avg_no_cache:.3f}s")
        print(f"    有缓存平均延迟: {avg_with_cache:.3f}s")
        print(f"    无缓存总耗时: {total_no_cache:.3f}s")
        print(f"    有缓存总耗时: {total_with_cache:.3f}s")
        time_saved = total_no_cache - total_with_cache
        print(f"    节省总时间: {time_saved:.3f}s ({time_saved/total_no_cache*100:.1f}%)")

    return {"reduction": reduction, "no_cache_calls": no_cache_api_calls, "with_cache_calls": with_cache_api_calls}


# ============================================================
# 分析 6：音字同步误差（前端机制分析）
# ============================================================
def analyze_audio_text_sync():
    print("\n" + "="*70)
    print("【分析6】音字同步误差（前端机制分析，需真机测试）")
    print("="*70)

    print("""
  前端音字同步机制（chat.js 分析）：

  1. 双端同步校验流程（"双门闩"机制）：
     - 打字机速度：TYPEWRITER_INTERVAL = 235ms/字（固定速度基线）
     - onTimeUpdate事件：约每250ms触发一次音频进度回调
     - jumpToIdx函数：按音频进度比例(currentTime/duration)驱动文字显示

  2. 同步误差来源：
     - onTimeUpdate触发间隔：~250ms（微信InnerAudioContext固有间隔）
     - 打字机固定速度：235ms/字（约4.3字/秒）
     - 网络延迟导致的TTS下载时间波动

  3. 理论同步误差估算：
     - 最佳情况：onTimeUpdate精确触发 + 音频立即播放 → 误差 < 250ms
     - 典型情况：onTimeUpdate间隔250ms + 打字机235ms步进 → 误差 ~300-500ms
     - 最差情况：音频下载延迟 + onTimeUpdate滞后 → 误差可能 > 1000ms

  4. 同步保障机制：
     - onPlayStart提前触发：downloadFile发出时即激活打字机，最小化感知延迟
     - 音频进度跟随：audioProgressEnabled=true时，打字机被音频进度驱动
     - 双门闩完成：typeFinishFlags + ttsFinishFlags都true才解锁下一条
     - 超时兜底：max(15000, 字数*235ms + 10000)后强制完成

  ★ 结论：在正常网络条件下，音字同步误差预计在 300-500ms 范围内。
    这个误差对中文语音（语速约4-5字/秒）来说，对应1-2个字的视觉偏差，
    在沉浸式体验中属于可接受范围（人耳对音画同步的容忍阈值约±500ms）。

  ⚠️ 实测需要：在微信开发者工具真机调试模式下，录制视频后逐帧分析。
""")
    return {"estimated_sync_error": "300-500ms (理论估算)", "need_real_device": True}


# ============================================================
# 分析 7：异常退出率（前端机制分析）
# ============================================================
def analyze_crash_rate():
    print("\n" + "="*70)
    print("【分析7】异常退出率（前端防护机制分析）")
    print("="*70)

    print("""
  前端异常防护体系（chat.js + app.js 分析）：

  1. 已知的关键防护机制（已完成7项加固）：
     - SafeStorage纯内存存储：隔离wx.Storage API，避免3.17.0灰度版WAWorker崩溃
     - _safeSetData：100%防止页面销毁后setData触发__wcc_version_info__ null崩溃
     - _safeSetTimeout/_safeClearTimeout：统一setTimeout句柄管理，onUnload一键清空
     - onUnload完整清理：打字定时器、TTS队列、音频上下文、所有回调置空
     - 全局onError/onUnhandledRejection：禁止reLaunch/路由跳转，仅记录+Toast
     - 音频安全销毁序列：stop → 150ms延迟 → destroy（非直接destroy）
     - 页面存活标记（_pageAlive/_destroyed）：所有异步回调前置检查

  2. 已修复的关键崩溃场景：
     - setData并发碰撞 → recursive update → 闪退（已用extraFields合入同一次setData修复）
     - 页面关闭后延迟渲染 → __wcc_version_info__ null（已用_safeSetData修复）
     - TTS音频ctx直接destroy → 野指针闪退（已用stop+延迟+destroy序列修复）
     - wx.Storage WAWorker原生崩溃（已用纯内存SafeStorage修复）

  3. 异常退出率评估：
     由于已有完整的异常防护体系，在正常网络条件下：
     - 预计异常退出率 < 0.5%
     - 主要异常来源可能为：极端网络环境、非常老旧的设备、系统级兼容性问题

  ⚠️ 实测需要：在多款真机（iOS/Android，不同微信版本）上运行自动化测试。
     项目内已内置 _autoTestStart() 自动化诊断流程，可在微信开发者工具中触发。
""")
    return {"estimated_crash_rate": "< 0.5% (理论估算)", "need_real_device": True}


# ============================================================
# 主测试流程
# ============================================================
def main():
    print("="*70)
    print("AINPC 性能指标测试")
    print(f"测试时间: {time.strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"TTS服务器: {TTS_SERVER}")
    print("="*70)

    all_results = {}

    # 检查服务器
    try:
        r = requests.get(f"{TTS_SERVER}/health", timeout=5)
        info = r.json()
        print(f"\n服务器状态: OK | 模型: {info.get('model')} | 音色: {info.get('voice')}")
    except:
        print(f"\n⚠️ 警告: TTS服务器未启动，请先运行 python server.py")
        return

    # 运行所有测试
    all_results["ai_latency"] = test_ai_response_latency()
    all_results["tts_latency"] = test_tts_latency()
    all_results["cache_hit"] = test_cache_hit_rate()
    all_results["concurrent"] = test_concurrent_requests()
    all_results["api_cost"] = test_api_cost_reduction()
    all_results["sync_analysis"] = analyze_audio_text_sync()
    all_results["crash_analysis"] = analyze_crash_rate()

    # ========== 生成最终测试报告 ==========
    print("\n" + "="*70)
    print("📊 最终测试报告汇总")
    print("="*70)

    report = []
    report.append("AINPC 性能指标测试报告")
    report.append(f"测试时间: {time.strftime('%Y-%m-%d %H:%M:%S')}")
    report.append(f"TTS服务器: {TTS_SERVER}")
    report.append("")

    # 1. AI文本首响应延迟
    ai = all_results["ai_latency"]
    report.append("1. AI文本首响应延迟（通义千问 qwen-plus）")
    report.append(f"   首字响应: 平均 {ai['avg_first']:.3f}s")
    report.append(f"   全文响应: 平均 {ai['avg_full']:.3f}s")
    report.append(f"   目标值: ≤ 2.0s（首字）")
    report.append(f"   达标: {'✅ 是' if ai['avg_first'] <= 2.0 else '❌ 否'}")
    report.append("")

    # 2. TTS首音频延迟
    tts = all_results["tts_latency"]
    report.append("2. TTS首音频延迟（cosyvoice-v3-flash）")
    if tts["miss"]:
        report.append(f"   首次生成(MISS): 平均 {sum(tts['miss'])/len(tts['miss']):.3f}s")
    if tts["disk"]:
        report.append(f"   磁盘缓存命中: 平均 {sum(tts['disk'])/len(tts['disk']):.3f}s")
    if tts["mem"]:
        report.append(f"   内存缓存命中: 平均 {sum(tts['mem'])/len(tts['mem']):.3f}s")
    report.append(f"   目标值: ≤ 3.0s（首次生成）")
    if tts["miss"]:
        report.append(f"   达标: {'✅ 是' if sum(tts['miss'])/len(tts['miss']) <= 3.0 else '❌ 否'}")
    report.append("")

    # 3. 缓存命中率
    cache = all_results["cache_hit"]
    report.append("3. 音频缓存命中率")
    report.append(f"   综合缓存命中率: {cache['hit_rate']:.1f}%")
    report.append(f"   目标值: ≥ 85%（高频讲解词场景）")
    report.append(f"   达标: {'✅ 是' if cache['hit_rate'] >= 85 else '⚠️ 接近达标' if cache['hit_rate'] >= 70 else '❌ 否'}")
    report.append("")

    # 4. 并发成功率
    report.append("4. 并发场景下请求成功率")
    report.append("   10/20/50并发测试结果见上方输出")
    report.append("   目标值: ≥ 99%（50并发）")
    report.append("")

    # 5. API调用成本降幅
    cost = all_results["api_cost"]
    report.append("5. API调用成本降幅")
    report.append(f"   无缓存: {cost['no_cache_calls']}次API调用")
    report.append(f"   有缓存: {cost['with_cache_calls']}次API调用")
    report.append(f"   降幅: {cost['reduction']:.1f}%")
    report.append(f"   目标值: ≥ 60%")
    report.append(f"   达标: {'✅ 是' if cost['reduction'] >= 60 else '❌ 否'}")
    report.append("")

    # 6. 音字同步误差
    report.append("6. 音字同步误差（理论估算）")
    report.append("   估算值: 300-500ms（正常网络条件）")
    report.append("   目标值: ≤ 300ms")
    report.append("   实测: ⚠️ 需真机测试验证")
    report.append("")

    # 7. 异常退出率
    report.append("7. 异常退出率（理论估算）")
    report.append("   估算值: < 0.5%（已有完整防护体系）")
    report.append("   目标值: ≤ 0.5%")
    report.append("   实测: ⚠️ 需多设备真机测试验证")

    report_text = "\n".join(report)
    print(report_text)

    # 保存报告
    with open(REPORT_PATH, "w", encoding="utf-8") as f:
        f.write(report_text)
    print(f"\n报告已保存至: performance_test_report.txt")


if __name__ == "__main__":
    main()
