(() => {
  "use strict";

  // Cloudflare 속도 측정 엔드포인트 (CORS 허용)
  const BASE = "https://speed.cloudflare.com";

  const CONFIG = {
    pingCount: 12,
    upload:   { duration: 10000, streams: 4, chunkBytes: 8 * 1024 * 1024, warmup: 1500 },
    download: { duration: 10000, streams: 6, chunkBytes: 25 * 1000 * 1000, warmup: 1500 },
    sampleInterval: 200,
    windowMs: 1000,
  };

  // 게이지 눈금 (비선형)
  const SCALE = [0, 5, 10, 50, 100, 250, 500, 750, 1000];

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const el = {
    card: $("gaugeCard"),
    track: $("arcTrack"),
    value: $("arcValue"),
    ticks: $("ticks"),
    needle: $("needle"),
    phase: $("phaseLabel"),
    speed: $("speedValue"),
    progress: $("progressBar"),
    btn: $("startBtn"),
    status: $("status"),
    server: $("server"),
    ping: $("pingValue"),
    jitter: $("jitterValue"),
    upload: $("uploadValue"),
    download: $("downloadValue"),
  };

  // ---------- 게이지 ----------
  const CX = 150, CY = 150, R = 120;
  const START = 135, SWEEP = 270;
  const ARC_LEN = (Math.PI * 2 * R * SWEEP) / 360;

  const polar = (deg, r = R) => {
    const rad = (deg * Math.PI) / 180;
    return [CX + r * Math.cos(rad), CY + r * Math.sin(rad)];
  };

  function buildGauge() {
    const [sx, sy] = polar(START);
    const [ex, ey] = polar(START + SWEEP);
    const d = `M ${sx} ${sy} A ${R} ${R} 0 1 1 ${ex} ${ey}`;
    el.track.setAttribute("d", d);
    el.value.setAttribute("d", d);
    el.value.style.strokeDasharray = `${ARC_LEN} ${ARC_LEN}`;
    el.value.style.strokeDashoffset = ARC_LEN;

    const ns = "http://www.w3.org/2000/svg";
    SCALE.forEach((v, i) => {
      const deg = START + (SWEEP * i) / (SCALE.length - 1);
      const [x1, y1] = polar(deg, R - 16);
      const [x2, y2] = polar(deg, R - 22);
      const line = document.createElementNS(ns, "line");
      line.setAttribute("x1", x1); line.setAttribute("y1", y1);
      line.setAttribute("x2", x2); line.setAttribute("y2", y2);
      line.setAttribute("class", "tick-mark");
      el.ticks.appendChild(line);

      const [tx, ty] = polar(deg, R - 36);
      const text = document.createElementNS(ns, "text");
      text.setAttribute("x", tx); text.setAttribute("y", ty);
      text.setAttribute("class", "tick-label");
      text.textContent = v >= 1000 ? "1G" : v;
      el.ticks.appendChild(text);
    });
  }

  function speedToFrac(v) {
    if (!(v > 0)) return 0;
    if (v >= SCALE[SCALE.length - 1]) return 1;
    for (let i = 1; i < SCALE.length; i++) {
      if (v <= SCALE[i]) {
        const part = (v - SCALE[i - 1]) / (SCALE[i] - SCALE[i - 1]);
        return (i - 1 + part) / (SCALE.length - 1);
      }
    }
    return 1;
  }

  // 부드러운 바늘 애니메이션
  let targetSpeed = 0, shownSpeed = 0;
  function animate() {
    shownSpeed += (targetSpeed - shownSpeed) * 0.12;
    if (Math.abs(targetSpeed - shownSpeed) < 0.005) shownSpeed = targetSpeed;
    const frac = speedToFrac(shownSpeed);
    el.value.style.strokeDashoffset = ARC_LEN * (1 - frac);
    el.needle.setAttribute("transform", `rotate(${START + SWEEP * frac} ${CX} ${CY})`);
    el.speed.textContent = fmt(shownSpeed);
    requestAnimationFrame(animate);
  }

  const fmt = (v) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2));

  // ---------- UI 헬퍼 ----------
  function setPhase(phase, label) {
    el.card.dataset.phase = phase;
    el.phase.textContent = label;
    document.querySelectorAll(".step").forEach((s) => {
      s.classList.toggle("active", s.dataset.step === phase);
    });
    document.querySelectorAll(".result").forEach((r) => {
      const k = r.dataset.kind;
      r.classList.toggle("live", k === phase || (phase === "ping" && k === "jitter"));
    });
  }
  const markDone = (step) => {
    const s = document.querySelector(`.step[data-step="${step}"]`);
    s.classList.remove("active");
    s.classList.add("done");
  };
  const setProgress = (p) => (el.progress.style.width = `${Math.min(100, Math.max(0, p * 100))}%`);
  const setStatus = (msg, isError = false) => {
    el.status.textContent = msg;
    el.status.classList.toggle("error", isError);
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const bust = () => `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;

  // ---------- 처리량 측정기 ----------
  // 전송된 바이트를 주기적으로 샘플링해 실시간 속도와 최종 속도를 계산
  function createMeter({ duration, warmup }, onTick) {
    const start = performance.now();
    let bytes = 0;
    let warmBytes = null, warmTime = null;
    const samples = [{ t: start, b: 0 }];

    const timer = setInterval(() => {
      const now = performance.now();
      samples.push({ t: now, b: bytes });
      while (samples.length > 2 && now - samples[0].t > CONFIG.windowMs) samples.shift();
      const first = samples[0];
      const dt = (now - first.t) / 1000;
      const mbps = dt > 0 ? ((bytes - first.b) * 8) / dt / 1e6 : 0;
      if (warmBytes === null && now - start >= warmup) {
        warmBytes = bytes; warmTime = now;
      }
      onTick(mbps, (now - start) / duration);
    }, CONFIG.sampleInterval);

    return {
      add(n) { bytes += n; },
      finish() {
        clearInterval(timer);
        const now = performance.now();
        const b0 = warmBytes ?? 0, t0 = warmTime ?? start;
        const secs = (now - t0) / 1000;
        return secs > 0 ? ((bytes - b0) * 8) / secs / 1e6 : 0;
      },
    };
  }

  // ---------- 핑 ----------
  async function measurePing() {
    const times = [];
    let meta = null;
    for (let i = 0; i < CONFIG.pingCount; i++) {
      const t0 = performance.now();
      const res = await fetch(`${BASE}/__down?bytes=0&r=${bust()}`, { cache: "no-store" });
      await res.arrayBuffer();
      const t = performance.now() - t0;
      if (!meta) {
        meta = {
          colo: res.headers.get("cf-meta-colo"),
          city: res.headers.get("cf-meta-city"),
          country: res.headers.get("cf-meta-country"),
        };
      }
      if (i > 0) times.push(t); // 첫 요청은 연결 설정 시간 포함 → 제외
      setProgress((i + 1) / CONFIG.pingCount);
      if (times.length) {
        const cur = Math.min(...times);
        el.ping.textContent = cur.toFixed(0);
      }
    }
    const sorted = [...times].sort((a, b) => a - b);
    const ping = sorted[Math.floor(sorted.length / 2)];
    let jitter = 0;
    for (let i = 1; i < times.length; i++) jitter += Math.abs(times[i] - times[i - 1]);
    jitter /= Math.max(1, times.length - 1);
    return { ping, jitter, meta };
  }

  // ---------- 업로드 ----------
  let uploadBlob = null;
  function getUploadBlob(size) {
    if (uploadBlob && uploadBlob.size === size) return uploadBlob;
    const buf = new Uint8Array(size);
    const step = 65536; // getRandomValues 한 번에 최대 64KB
    for (let o = 0; o < size; o += step) {
      crypto.getRandomValues(buf.subarray(o, Math.min(o + step, size)));
    }
    uploadBlob = new Blob([buf]);
    return uploadBlob;
  }

  async function measureUpload() {
    const cfg = CONFIG.upload;
    const blob = getUploadBlob(cfg.chunkBytes);
    const xhrs = new Set();
    let stop = false;
    let errors = 0;

    const meter = createMeter(cfg, (mbps, p) => {
      targetSpeed = mbps;
      el.upload.textContent = fmt(mbps);
      setProgress(p);
    });

    const worker = async () => {
      while (!stop) {
        await new Promise((resolve) => {
          const xhr = new XMLHttpRequest();
          let last = 0;
          xhrs.add(xhr);
          xhr.upload.onprogress = (e) => {
            meter.add(e.loaded - last);
            last = e.loaded;
          };
          xhr.onload = () => {
            if (!stop && blob.size > last) meter.add(blob.size - last);
          };
          xhr.onerror = () => { errors++; };
          xhr.onloadend = () => { xhrs.delete(xhr); resolve(); };
          xhr.open("POST", `${BASE}/__up?r=${bust()}`, true);
          xhr.send(blob);
        });
        if (errors > 20) throw new Error("업로드 요청이 계속 실패합니다.");
        if (errors) await sleep(150);
      }
    };

    const workers = Array.from({ length: cfg.streams }, (_, i) => sleep(i * 120).then(worker));
    await sleep(cfg.duration);
    stop = true;
    const result = meter.finish();
    xhrs.forEach((x) => x.abort());
    await Promise.allSettled(workers);
    if (errors > 20) throw new Error("업로드 측정에 실패했습니다.");
    return result;
  }

  // ---------- 다운로드 ----------
  async function measureDownload() {
    const cfg = CONFIG.download;
    const controllers = new Set();
    let stop = false;
    let errors = 0;

    const meter = createMeter(cfg, (mbps, p) => {
      targetSpeed = mbps;
      el.download.textContent = fmt(mbps);
      setProgress(p);
    });

    const worker = async () => {
      while (!stop) {
        const ctrl = new AbortController();
        controllers.add(ctrl);
        try {
          const res = await fetch(`${BASE}/__down?bytes=${cfg.chunkBytes}&r=${bust()}`, {
            cache: "no-store",
            signal: ctrl.signal,
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const reader = res.body.getReader();
          while (!stop) {
            const { done, value } = await reader.read();
            if (done) break;
            meter.add(value.byteLength);
          }
        } catch (e) {
          if (!stop) { errors++; await sleep(200); }
        } finally {
          controllers.delete(ctrl);
        }
        if (errors > 20) return;
      }
    };

    const workers = Array.from({ length: cfg.streams }, (_, i) => sleep(i * 100).then(worker));
    await sleep(cfg.duration);
    stop = true;
    const result = meter.finish();
    controllers.forEach((c) => c.abort());
    await Promise.allSettled(workers);
    if (errors > 20) throw new Error("다운로드 측정에 실패했습니다.");
    return result;
  }

  // ---------- 실행 ----------
  function reset() {
    ["ping", "jitter", "upload", "download"].forEach((k) => (el[k].textContent = "–"));
    document.querySelectorAll(".step").forEach((s) => s.classList.remove("active", "done"));
    targetSpeed = 0;
    setProgress(0);
  }

  async function run() {
    el.btn.disabled = true;
    el.btn.querySelector(".start-text").textContent = "측정 중…";
    reset();

    try {
      // 1) 핑
      setPhase("ping", "핑 측정 중");
      setStatus("서버 응답 시간을 측정하고 있습니다…");
      const { ping, jitter, meta } = await measurePing();
      el.ping.textContent = ping.toFixed(0);
      el.jitter.textContent = jitter.toFixed(1);
      if (meta && meta.colo) {
        const where = [meta.city, meta.country].filter(Boolean).join(", ");
        el.server.textContent = `서버: Cloudflare ${meta.colo}${where ? ` · ${where}` : ""}`;
      }
      markDone("ping");

      // 2) 업로드
      setPhase("upload", "업로드");
      setStatus("업로드 속도를 측정하고 있습니다…");
      setProgress(0);
      const up = await measureUpload();
      el.upload.textContent = fmt(up);
      markDone("upload");
      targetSpeed = 0;
      await sleep(600);

      // 3) 다운로드
      setPhase("download", "다운로드");
      setStatus("다운로드 속도를 측정하고 있습니다…");
      setProgress(0);
      const down = await measureDownload();
      el.download.textContent = fmt(down);
      markDone("download");

      targetSpeed = down;
      setPhase("done", "측정 완료");
      el.card.dataset.phase = "download";
      setProgress(1);
      setStatus(`측정 완료 · 업로드 ${fmt(up)} Mbps · 다운로드 ${fmt(down)} Mbps`);
    } catch (err) {
      console.error(err);
      targetSpeed = 0;
      setPhase("idle", "오류");
      setStatus(`측정 중 오류가 발생했습니다: ${err.message || err}`, true);
    } finally {
      el.btn.disabled = false;
      el.btn.querySelector(".start-text").textContent = "다시 측정";
    }
  }

  buildGauge();
  requestAnimationFrame(animate);
  el.btn.addEventListener("click", run);
})();
