import { useEffect, useRef } from "react";

const SENTENCES = [
  // chat culture
  "you up?",
  "lol that's wild",
  "brb getting snacks",
  "typing...",
  "no u",
  "sent from my toaster",
  "read at 3:47am",
  "new chat who dis",
  "tl;dr it was chaos",
  "gg no re",
  "hot take incoming",
  "big if true",
  "source: trust me bro",
  "based and redpilled",
  "inb4 someone disagrees",
  "lurking intensifies",
  "skill issue tbh",
  "ratio'd in real time",
  "certified hood classic",
  "least unhinged user",
  // space & astronomy
  "voyager 1 is 24 billion km away",
  "the sun mass is 99.86% of solar system",
  "a day on venus is longer than its year",
  "neutron stars spin 716 times per second",
  "olympus mons is 2.5x everest's height",
  "there are more stars than grains of sand",
  "saturn would float in a big enough bath",
  "light takes 8 minutes from sun to earth",
  "the moon drifts 3.8cm away each year",
  "space smells like seared steak apparently",
  "andromeda is on a collision course with us",
  "one teaspoon of neutron star weighs 6B tons",
  // computing & tech
  "there are 10 types of people in the world",
  "the first computer bug was an actual moth",
  "null pointer walked into a bar. segfault",
  "rm -rf / moment",
  "it works on my machine",
  "have you tried turning it off and on again",
  "localhost is where the heart is",
  "chmod 777 and pray",
  "the cloud is just someone else's computer",
  "linux users btw",
  "vim users are still trying to exit",
  "git push --force and hope for the best",
  "sudo make me a sandwich",
  "there's no place like 127.0.0.1",
  "malloc failed. everything failed.",
  "99 little bugs in the code. fix one. 127.",
  // nerdy fun facts
  "honey never spoils. ever.",
  "octopi have three hearts and blue blood",
  "a group of flamingos is called a flamboyance",
  "bananas are technically berries",
  "oxford university is older than the aztecs",
  "cleopatra lived closer to pizza hut than pyramids",
  "the mantis shrimp sees 16 color channels",
  "tardigrades survive the vacuum of space",
  "a jiffy is an actual unit of time (1/100s)",
  "sharks are older than trees",
  // protocol & network
  "ping",
  "pong",
  "ack",
  "syncing vibes...",
  "packet lost in transit",
  "buffering...",
  "connection established",
  "decrypting gossip...",
  "negotiating bandwidth",
  "TCP handshake complete",
  "404 sleep not found",
  "418 i'm a teapot",
  "establishing encrypted channel...",
  // atmospheric
  "whispers in the void",
  "murmurs on the wire",
  "echoes of conversations",
  "fragments of thought",
  "signals in the static",
  "ghosts in the machine",
  "damnation - milk",
  "ur mum -emu",
  "bullish -falken",
  "scandalous -rebond",
  "clusterfuck -kenna",
  "Soon™ - banji"


];

interface ActiveSentence {
  text: string;
  x: number;
  y: number;
  charsRevealed: number;
  phase: "typing" | "hold" | "fadeout";
  holdTicksLeft: number;
  opacity: number;
}

export function HalftoneBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;

    const MAX_ACTIVE = 4;
    const SPAWN_INTERVAL_MS = 1800;
    const FONT_SIZE = 30;
    const MAX_OPACITY = 0.35;
    const GLOW_BLUR = 8; // CRT phosphor glow radius
    const FADE_OUT_STEP = MAX_OPACITY / 30; // ~1s at 30fps
    const FRAME_INTERVAL = 1000 / 30;
    // Flicker: per-sentence phosphor jitter
    const FLICKER_MIN = 0.88; // normal jitter floor (subtle shimmer)
    const FLICKER_MAX = 1.0;
    // Rare voltage dip — dims everything briefly (toned down)
    const DIP_CHANCE = 0.005; // ~once every 6-7s at 30fps
    const DIP_DEPTH = 0.2; // gentle dim
    const DIP_RECOVERY = 0.08; // slower recovery looks more natural
    let dipAmount = 0; // 0 = no dip, 1 = full dip

    // CRT background layers (offscreen canvases, rebuilt on resize)
    const SCANLINE_ALPHA = 0.16;
    const SCANLINE_GAP = 2; // tighter scanlines = more CRT feel
    const VIGNETTE_STRENGTH = 0.7; // heavy darkening at edges
    const NOISE_ALPHA = 0.07; // visible grain
    const NOISE_REFRESH_FRAMES = 8; // slow crawl, not strobing

    let scanlineCanvas: HTMLCanvasElement | null = null;
    let vignetteCanvas: HTMLCanvasElement | null = null;
    let noiseCanvas: HTMLCanvasElement | null = null;
    let noiseFrameCount = 0;

    let activeSentences: ActiveSentence[] = [];
    let animId = 0;
    let lastFrame = 0;
    let lastSpawn = 0;

    function buildScanlines(w: number, h: number) {
      scanlineCanvas = document.createElement("canvas");
      scanlineCanvas.width = w;
      scanlineCanvas.height = h;
      const sctx = scanlineCanvas.getContext("2d")!;
      sctx.fillStyle = `rgba(0, 0, 0, ${SCANLINE_ALPHA})`;
      for (let y = 0; y < h; y += SCANLINE_GAP) {
        sctx.fillRect(0, y, w, 1);
      }
    }

    function buildVignette(w: number, h: number) {
      vignetteCanvas = document.createElement("canvas");
      vignetteCanvas.width = w;
      vignetteCanvas.height = h;
      const vctx = vignetteCanvas.getContext("2d")!;
      const cx = w / 2;
      const cy = h / 2;
      const radius = Math.sqrt(cx * cx + cy * cy);
      const grad = vctx.createRadialGradient(cx, cy, radius * 0.2, cx, cy, radius);
      grad.addColorStop(0, "rgba(0,0,0,0)");
      grad.addColorStop(0.5, `rgba(0,0,0,${VIGNETTE_STRENGTH * 0.15})`);
      grad.addColorStop(0.75, `rgba(0,0,0,${VIGNETTE_STRENGTH * 0.45})`);
      grad.addColorStop(1, `rgba(0,0,0,${VIGNETTE_STRENGTH})`);
      vctx.fillStyle = grad;
      vctx.fillRect(0, 0, w, h);
    }

    function buildNoise(w: number, h: number) {
      noiseCanvas = document.createElement("canvas");
      // Noise at half resolution for performance + softer look
      const nw = Math.ceil(w / 2);
      const nh = Math.ceil(h / 2);
      noiseCanvas.width = nw;
      noiseCanvas.height = nh;
      const nctx = noiseCanvas.getContext("2d")!;
      const imageData = nctx.createImageData(nw, nh);
      const data = imageData.data;
      for (let i = 0; i < data.length; i += 4) {
        const v = Math.random() * 255;
        data[i] = v;
        data[i + 1] = v;
        data[i + 2] = v;
        data[i + 3] = NOISE_ALPHA * 255;
      }
      nctx.putImageData(imageData, 0, 0);
    }

    function resize() {
      const dpr = window.devicePixelRatio || 1;
      canvas!.width = window.innerWidth * dpr;
      canvas!.height = window.innerHeight * dpr;
      canvas!.style.width = window.innerWidth + "px";
      canvas!.style.height = window.innerHeight + "px";
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);

      const w = window.innerWidth;
      const h = window.innerHeight;
      buildScanlines(w, h);
      buildVignette(w, h);
      buildNoise(w, h);
    }

    function getExclusionZone() {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const zw = w * 0.5;
      const zh = h * 0.45;
      return {
        left: (w - zw) / 2,
        right: (w + zw) / 2,
        top: (h - zh) / 2,
        bottom: (h + zh) / 2,
      };
    }

    function spawnSentence(now: number) {
      if (activeSentences.length >= MAX_ACTIVE) return;
      if (now - lastSpawn < SPAWN_INTERVAL_MS) return;
      lastSpawn = now;

      // Pick a sentence not currently on screen
      const onScreen = new Set(activeSentences.map((s) => s.text));
      const available = SENTENCES.filter((s) => !onScreen.has(s));
      if (available.length === 0) return;

      const text = available[Math.floor(Math.random() * available.length)];
      const w = window.innerWidth;
      const h = window.innerHeight;
      const exclusion = getExclusionZone();

      // Measure text width to avoid placing off-screen
      ctx!.font = `${FONT_SIZE}px "JetBrains Mono", monospace`;
      const textWidth = ctx!.measureText(text).width;

      const margin = 40;
      // Try to find a position outside exclusion zone
      let x = 0;
      let y = 0;
      let attempts = 0;
      do {
        x = margin + Math.random() * (w - textWidth - margin * 2);
        y = margin + FONT_SIZE + Math.random() * (h - margin * 2 - FONT_SIZE);
        attempts++;
      } while (
        attempts < 30 &&
        x + textWidth > exclusion.left &&
        x < exclusion.right &&
        y > exclusion.top - FONT_SIZE &&
        y < exclusion.bottom + FONT_SIZE
      );

      // If we couldn't find a position outside the zone, skip this spawn
      if (
        attempts >= 30 &&
        x + textWidth > exclusion.left &&
        x < exclusion.right &&
        y > exclusion.top - FONT_SIZE &&
        y < exclusion.bottom + FONT_SIZE
      ) {
        return;
      }

      activeSentences.push({
        text,
        x,
        y,
        charsRevealed: 0,
        phase: "typing",
        holdTicksLeft: 0,
        opacity: 0,
      });
    }

    function draw(now: number) {
      animId = requestAnimationFrame(draw);

      const delta = now - lastFrame;
      if (delta < FRAME_INTERVAL) return;
      lastFrame = now - (delta % FRAME_INTERVAL);

      const w = window.innerWidth;
      const h = window.innerHeight;

      // Clear to near-black
      ctx!.fillStyle = "#0a0a0a";
      ctx!.fillRect(0, 0, w, h);

      // Stamp CRT scanlines
      if (scanlineCanvas) {
        ctx!.drawImage(scanlineCanvas, 0, 0);
      }

      // Slowly refreshing noise grain (not every frame — avoids flicker)
      noiseFrameCount++;
      if (noiseFrameCount >= NOISE_REFRESH_FRAMES) {
        noiseFrameCount = 0;
        buildNoise(w, h);
      }
      if (noiseCanvas) {
        ctx!.drawImage(noiseCanvas, 0, 0, w, h);
      }

      ctx!.font = `${FONT_SIZE}px "JetBrains Mono", monospace`;
      ctx!.textBaseline = "alphabetic";

      // Voltage dip — rare global flicker
      if (dipAmount > 0) {
        dipAmount = Math.max(0, dipAmount - DIP_RECOVERY);
      } else if (Math.random() < DIP_CHANCE) {
        dipAmount = DIP_DEPTH + Math.random() * 0.25;
      }
      const globalFlicker = 1 - dipAmount;

      // Update and draw each sentence
      for (let i = activeSentences.length - 1; i >= 0; i--) {
        const s = activeSentences[i];

        if (s.phase === "typing") {
          s.charsRevealed += 1;
          const progress = s.charsRevealed / s.text.length;
          s.opacity = MAX_OPACITY * Math.min(progress * 1.5, 1);

          if (s.charsRevealed >= s.text.length) {
            s.phase = "hold";
            s.opacity = MAX_OPACITY;
            // Hold for 1.3–3s at 30fps
            s.holdTicksLeft = Math.floor(30 * (1.3 + Math.random() * 1.7));
          }
        } else if (s.phase === "hold") {
          s.holdTicksLeft--;
          if (s.holdTicksLeft <= 0) {
            s.phase = "fadeout";
          }
        } else {
          // fadeout
          s.opacity -= FADE_OUT_STEP;
          if (s.opacity <= 0) {
            activeSentences.splice(i, 1);
            continue;
          }
        }

        // Per-sentence phosphor jitter + global voltage dip
        const jitter =
          FLICKER_MIN + Math.random() * (FLICKER_MAX - FLICKER_MIN);
        const flickerOpacity = s.opacity * jitter * globalFlicker;
        const flickerGlow =
          GLOW_BLUR * (flickerOpacity / MAX_OPACITY) * globalFlicker;

        // Draw revealed text with CRT phosphor glow
        const revealed = s.text.slice(0, s.charsRevealed);

        // Glow layer — soft bloom behind the text
        ctx!.save();
        ctx!.shadowColor = `rgba(180, 210, 255, ${flickerOpacity * 0.8})`;
        ctx!.shadowBlur = flickerGlow;
        ctx!.fillStyle = `rgba(200, 220, 255, ${flickerOpacity * 0.6})`;
        ctx!.fillText(revealed, s.x, s.y);
        ctx!.restore();

        // Crisp text layer on top
        ctx!.fillStyle = `rgba(220, 230, 255, ${flickerOpacity})`;
        ctx!.fillText(revealed, s.x, s.y);

        // Draw cursor bar during typing
        if (s.phase === "typing") {
          const cursorX = s.x + ctx!.measureText(revealed).width + 1;
          ctx!.save();
          ctx!.shadowColor = `rgba(180, 210, 255, ${flickerOpacity * 0.5})`;
          ctx!.shadowBlur = 4;
          ctx!.fillStyle = `rgba(200, 220, 255, ${flickerOpacity * 0.7})`;
          ctx!.fillRect(cursorX, s.y - FONT_SIZE + 2, 1.5, FONT_SIZE);
          ctx!.restore();
        }
      }

      // Vignette on top of everything — darkens edges over text too
      if (vignetteCanvas) {
        ctx!.drawImage(vignetteCanvas, 0, 0);
      }

      // Try to spawn
      spawnSentence(now);
    }

    resize();
    animId = requestAnimationFrame(draw);
    window.addEventListener("resize", resize);

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 0,
        pointerEvents: "none",
      }}
    />
  );
}
