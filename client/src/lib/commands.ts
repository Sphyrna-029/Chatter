import type { AppState } from "./store";
import type { RoomSummary } from "./api";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CommandResult {
  output: string;
  type: "success" | "error" | "info";
  closeAfter?: boolean;
}

export interface CommandContext {
  state: AppState;
  createRoom: (name: string, topic: string) => Promise<void>;
  joinRoom: (roomId: string) => Promise<void>;
  leaveRoom: (roomId: string) => Promise<void>;
  selectRoom: (roomId: string) => Promise<void>;
  getAllRooms: () => Promise<RoomSummary[]>;
  setCustomStatus: (status: string) => void;
  sendMessage: (body: string) => Promise<void>;
  loadRooms: () => Promise<void>;
  updateTopic: (roomId: string, topic: string) => Promise<void>;
}

export interface Command {
  name: string;
  aliases: string[];
  description: string;
  usage: string;
  execute: (args: string[], ctx: CommandContext) => Promise<CommandResult>;
}

// ─── Commands ────────────────────────────────────────────────────────────────

const commands: Command[] = [
  {
    name: "help",
    aliases: ["h", "?"],
    description: "List commands or show help for a specific command",
    usage: "/help [command]",
    execute: async (args) => {
      if (args.length > 0) {
        const cmd = findCommand(args[0]);
        if (!cmd) return { output: `Unknown command: ${args[0]}`, type: "error" };
        const aliases = cmd.aliases.length ? ` (aliases: ${cmd.aliases.join(", ")})` : "";
        return {
          output: `${cmd.name}${aliases}\n  ${cmd.description}\n  Usage: ${cmd.usage}`,
          type: "info",
        };
      }
      const lines = commands
        .filter((c) => !["cowsay", "netrun", "starfield", "grace", "skull"].includes(c.name))
        .map((c) => `  /${c.name.padEnd(10)} ${c.description}`);
      return { output: `Available commands:\n${lines.join("\n")}`, type: "info" };
    },
  },
  {
    name: "create",
    aliases: ["new"],
    description: "Create a new room and join it",
    usage: "/create <room-name>",
    execute: async (args, ctx) => {
      const name = args.join(" ").trim();
      if (!name) return { output: "Usage: /create <room-name>", type: "error" };
      try {
        await ctx.createRoom(name, "");
        await ctx.loadRooms();
        return { output: `Room "${name}" created and joined.`, type: "success", closeAfter: true };
      } catch (err: any) {
        return { output: `Failed to create room: ${err.message || err}`, type: "error" };
      }
    },
  },
  {
    name: "join",
    aliases: ["j"],
    description: "Join a room by name (fuzzy match)",
    usage: "/join <room-name>",
    execute: async (args, ctx) => {
      const query = args.join(" ").trim().toLowerCase();
      if (!query) return { output: "Usage: /join <room-name>", type: "error" };
      try {
        const allRooms = await ctx.getAllRooms();
        const exact = allRooms.find((r) => r.name.toLowerCase() === query);
        const match = exact || allRooms.find((r) => r.name.toLowerCase().includes(query));
        if (!match) return { output: `No room matching "${query}" found.`, type: "error" };
        await ctx.joinRoom(match.room_id);
        await ctx.loadRooms();
        await ctx.selectRoom(match.room_id);
        return { output: `Joined "${match.name}".`, type: "success", closeAfter: true };
      } catch (err: any) {
        return { output: `Failed to join: ${err.message || err}`, type: "error" };
      }
    },
  },
  {
    name: "leave",
    aliases: ["part"],
    description: "Leave the current room",
    usage: "/leave",
    execute: async (_args, ctx) => {
      if (!ctx.state.currentRoomId) return { output: "No room selected.", type: "error" };
      const roomName = ctx.state.roomInfoMap[ctx.state.currentRoomId]?.name || "this room";
      try {
        await ctx.leaveRoom(ctx.state.currentRoomId);
        await ctx.loadRooms();
        return { output: `Left "${roomName}".`, type: "success", closeAfter: true };
      } catch (err: any) {
        return { output: `Failed to leave: ${err.message || err}`, type: "error" };
      }
    },
  },
  {
    name: "rooms",
    aliases: ["ls"],
    description: "List your joined rooms",
    usage: "/rooms",
    execute: async (_args, ctx) => {
      const ids = ctx.state.joinedRoomIds;
      if (ids.length === 0) return { output: "You haven't joined any rooms.", type: "info" };
      const lines = ids.map((id) => {
        const info = ctx.state.roomInfoMap[id];
        const name = info?.name || id;
        const current = id === ctx.state.currentRoomId ? " <-" : "";
        return `  ${name}${current}`;
      });
      return { output: `Joined rooms (${ids.length}):\n${lines.join("\n")}`, type: "info" };
    },
  },
  {
    name: "switch",
    aliases: ["sw", "go"],
    description: "Switch to a joined room by name",
    usage: "/switch <room-name>",
    execute: async (args, ctx) => {
      const query = args.join(" ").trim().toLowerCase();
      if (!query) return { output: "Usage: /switch <room-name>", type: "error" };
      const match = ctx.state.joinedRoomIds.find((id) => {
        const name = ctx.state.roomInfoMap[id]?.name?.toLowerCase() || "";
        return name === query || name.includes(query);
      });
      if (!match) return { output: `No joined room matching "${query}".`, type: "error" };
      await ctx.selectRoom(match);
      const name = ctx.state.roomInfoMap[match]?.name || match;
      return { output: `Switched to "${name}".`, type: "success", closeAfter: true };
    },
  },
  {
    name: "topic",
    aliases: [],
    description: "Set the topic of the current room",
    usage: "/topic <text>",
    execute: async (args, ctx) => {
      if (!ctx.state.currentRoomId) return { output: "No room selected.", type: "error" };
      const topic = args.join(" ").trim();
      if (!topic) return { output: "Usage: /topic <text>", type: "error" };
      try {
        await ctx.updateTopic(ctx.state.currentRoomId, topic);
        return { output: `Topic set to: ${topic}`, type: "success" };
      } catch (err: any) {
        return { output: `Failed to set topic: ${err.message || err}`, type: "error" };
      }
    },
  },
  {
    name: "status",
    aliases: [],
    description: "Set your custom status",
    usage: "/status <text>",
    execute: async (args, ctx) => {
      const status = args.join(" ").trim();
      if (!status) return { output: "Usage: /status <text>", type: "error" };
      ctx.setCustomStatus(status);
      return { output: `Status set to: ${status}`, type: "success" };
    },
  },
  {
    name: "ping",
    aliases: ["info"],
    description: "Show current room info and your user ID",
    usage: "/ping",
    execute: async (_args, ctx) => {
      const lines: string[] = [];
      lines.push(`User: ${ctx.state.userId || "unknown"}`);
      if (ctx.state.currentRoomId) {
        const info = ctx.state.roomInfoMap[ctx.state.currentRoomId];
        lines.push(`Room: ${info?.name || ctx.state.currentRoomId}`);
        if (info?.topic) lines.push(`Topic: ${info.topic}`);
        lines.push(`Members: ${ctx.state.roomMembers.length}`);
      } else {
        lines.push("No room selected.");
      }
      return { output: lines.join("\n"), type: "info" };
    },
  },
  {
    name: "clear",
    aliases: ["cls"],
    description: "Clear CLI output history",
    usage: "/clear",
    execute: async () => {
      // Handled specially by CommandBar — it checks for this name
      return { output: "", type: "success" };
    },
  },
  {
    name: "starfield",
    aliases: ["stars", "space"],
    description: "Generate a random ASCII starfield",
    usage: "/starfield [density]",
    execute: async (args) => {
      const density = Math.min(Math.max(parseInt(args[0]) || 3, 1), 10);
      const width = 48;
      const height = 14;
      const chars = [" ", " ", " ", " ", ".", ".", "*", "+", ".", " ", " ", " "];
      const sparseChars = [" ", " ", " ", " ", " ", " ", " ", ".", ".", "*"];
      const palette = density > 5 ? chars : sparseChars;

      const lines: string[] = [];
      for (let y = 0; y < height; y++) {
        let line = "";
        for (let x = 0; x < width; x++) {
          line += palette[Math.floor(Math.random() * palette.length)];
        }
        lines.push(line);
      }

      // Add a little ship or planet
      const mid = Math.floor(height / 2);
      const row = lines[mid].split("");
      const shipPos = Math.floor(width * 0.7);
      row.splice(shipPos, 3, "<", "=", ">");
      lines[mid] = row.join("");

      return { output: lines.join("\n"), type: "info" };
    },
  },
  {
    name: "netrun",
    aliases: ["breach", "jack", "hack"],
    description: "Jack into the NET — Breach Protocol",
    usage: "/netrun [ice-level]",
    execute: async (args) => {
      const iceLevel = Math.min(Math.max(parseInt(args[0]) || 2, 1), 5);
      const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
      const hex = () => pick("0123456789ABCDEF".split("")) + pick("0123456789ABCDEF".split(""));

      // ── Breach Protocol hex matrix ──
      const matSize = 4 + iceLevel;
      const matrix: string[][] = [];
      for (let r = 0; r < matSize; r++) {
        const row: string[] = [];
        for (let c = 0; c < matSize; c++) row.push(hex());
        matrix.push(row);
      }

      // Pick a "solution path" through the matrix (alternating row/col picks)
      const seqLen = 2 + iceLevel;
      const seq: string[] = [];
      let curRow = Math.floor(Math.random() * matSize);
      let curCol = Math.floor(Math.random() * matSize);
      for (let i = 0; i < seqLen; i++) {
        seq.push(matrix[curRow][curCol]);
        if (i % 2 === 0) curCol = Math.floor(Math.random() * matSize);
        else curRow = Math.floor(Math.random() * matSize);
      }

      // Daemon names — Edgerunners / cyberpunk references
      const daemons = [
        "DATAMINE_V1",    "DATAMINE_V2",    "DATAMINE_V3",
        "ICEPICK",        "MASS_VULN",      "OPTICS_JAMMER",
        "CRIPPLE_MOV",    "SYNAPSE_BURNOUT","CONTAGION",
        "SHORT_CIRCUIT",  "CYBERPSYCHO",    "PING_DAEMON",
        "SANDEVISTAN",    "MONOWIRE_HOOK",  "MANTIS_BLADE",
        "LUCY_GHOST",     "DAVID_OVERCLOCK","SMASHER_KILL",
        "KIWI_BACKDOOR",  "BECCA_BARRAGE",  "FALCO_EXFIL",
        "RACHE_BARTMOSS", "ALT_CUNNINGHAM", "BLACKWALL_TAP",
        "ARASAKA_WORM",   "NETWATCH_SPOOF", "MILITECH_SIPHON",
      ];

      // Select daemons to "upload" based on ICE level
      const activeDaemons = Array.from(
        { length: Math.min(1 + iceLevel, 5) },
        () => pick(daemons)
      ).filter((v, i, a) => a.indexOf(v) === i); // unique

      // ── Build output ──
      const lines: string[] = [];

      // Header
      lines.push("╔══════════════════════════════════════════════╗");
      lines.push("║  BREACH PROTOCOL v4.2.77 — NETRUNNER DECK   ║");
      lines.push("╠══════════════════════════════════════════════╣");
      lines.push(`║  ICE LEVEL: ${"█".repeat(iceLevel)}${"░".repeat(5 - iceLevel)}  [${iceLevel}/5]                  ║`);
      lines.push("╚══════════════════════════════════════════════╝");
      lines.push("");

      // Code matrix
      lines.push("┌─ CODE MATRIX ─────────────────┐");
      for (const row of matrix) {
        lines.push("│  " + row.join("  ") + "  │");
      }
      lines.push("└───────────────────────────────-┘");
      lines.push("");

      // Buffer sequence
      lines.push("BUFFER: [ " + seq.join(" → ") + " ]");
      lines.push("");

      // Daemon upload status
      lines.push("┌─ DAEMONS ─────────────────────┐");
      for (const d of activeDaemons) {
        const uploaded = Math.random() > 0.3;
        const status = uploaded ? "UPLOADED ■" : "FAILED   □";
        const color = uploaded ? "+" : "-";
        lines.push(`│ ${color} ${d.padEnd(18)} ${status} │`);
      }
      lines.push("└───────────────────────────────┘");
      lines.push("");

      // Flavor text — random netrunner status lines
      const flavorLines = [
        ">> Jacking in through local subnet...",
        ">> ICE detected — running BREACH PROTOCOL",
        `>> Neural link stable — latency ${Math.floor(Math.random() * 12) + 1}ms`,
        ">> RAM: ██████░░ 6/8 available",
        ">> Cyberdeck: Arasaka MK.5 [MODDED]",
        ">> Signal routed through " + pick(["Kabuki", "Japantown", "Watson", "Pacifica", "Dogtown", "Heywood", "Afterlife"]) + " relay",
        ">> Daemon payload delivered. Flatline the ICE.",
        ">> Remember — never fade away, choom.",
        ">> \"A thing of beauty... I know what I have to do.\"",
        ">> Connection trace: MASKED via Bartmoss' Ghost",
      ];

      // Pick a few random flavor lines
      const numFlavor = 3 + Math.floor(Math.random() * 3);
      const shuffled = flavorLines.sort(() => Math.random() - 0.5);
      for (let i = 0; i < Math.min(numFlavor, shuffled.length); i++) {
        lines.push(shuffled[i]);
      }

      lines.push("");
      lines.push(">> BREACH COMPLETE. Stay chrome, netrunner. ◈");

      return { output: lines.join("\n"), type: "info" };
    },
  },
  {
    name: "grace",
    aliases: ["tarnished", "bonfire", "rest"],
    description: "Discover a Site of Grace",
    usage: "/grace [area]",
    execute: async (args) => {
      const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

      const graces: { name: string; area: string; lore: string }[] = [
        { name: "The First Step", area: "Limgrave", lore: "Where all Tarnished begin their journey anew." },
        { name: "Church of Elleh", area: "Limgrave", lore: "A ruined church watched over by a familiar merchant." },
        { name: "Stormveil Cliffside", area: "Stormveil Castle", lore: "The winds howl. Godrick's domain awaits." },
        { name: "Raya Lucaria Grand Library", area: "Liurnia", lore: "Rennala sits among her amber eggs, humming softly." },
        { name: "Erdtree-Gazing Hill", area: "Altus Plateau", lore: "The golden tree looms above. Its light feels... hollow." },
        { name: "Beside the Great Bridge", area: "Farum Azula", lore: "Time is broken here. The Dragonlord waits." },
        { name: "Foot of the Forge", area: "Mountaintops", lore: "The flame that would burn the Erdtree. Melina watches." },
        { name: "Fractured Marika", area: "Erdtree", lore: "The Elden Ring lies shattered before you." },
        { name: "Cocoon of the Empyrean", area: "Haligtree", lore: "Malenia, Blade of Miquella, has never known defeat." },
        { name: "Dynasty Mausoleum", area: "Mohgwyn Palace", lore: "Blood and fire. The Lord of Blood schemes below." },
        { name: "Ranni's Chamber", area: "Ranni's Rise", lore: "The witch in the tower offers a different path." },
        { name: "Roundtable Hold", area: "The Erdtree", lore: "A place between places. The Tarnished gather here." },
        { name: "Ensis Moongazing Grounds", area: "Shadow Realm", lore: "The DLC lands stretch before you, unknown and vast." },
        { name: "Scorched Ruins", area: "Gravesite Plain", lore: "Messmer's flame has touched everything here." },
      ];

      // Filter by area arg if provided
      const areaQuery = args.join(" ").trim().toLowerCase();
      const pool = areaQuery
        ? graces.filter((g) => g.area.toLowerCase().includes(areaQuery) || g.name.toLowerCase().includes(areaQuery))
        : graces;
      const site = pool.length > 0 ? pick(pool) : pick(graces);

      const messages: string[] = [
        "Put these foolish ambitions to rest.",
        "I am Malenia, Blade of Miquella.",
        "Rise, ye Tarnished.",
        "Someone must extinguish thy flame.",
        "Thy strength befits a crown.",
        "The Elden Ring... is no more.",
        "I have given thee courtesy enough.",
        "Maidenless, are we?",
        "Let us learn together.",
        "The stars move once more.",
        "Try fingers, but hole.",
        "Ahh, I knew you'd come.",
        "Arise now, ye Tarnished. Ye dead, who yet live.",
      ];

      const enemies = [
        "Soldier of Godrick", "Grafted Scion", "Crucible Knight",
        "Runebear", "Erdtree Avatar", "Cleanrot Knight",
        "Black Knife Assassin", "Godskin Noble", "Abductor Virgin",
        "Revenant", "Lesser Dragonkin", "Deathbird",
      ];

      const ashes = [
        "Mimic Tear", "Lone Wolf Ashes", "Jellyfish Spirit",
        "Black Knife Tiche", "Lhutel the Headless", "Banished Knight Oleg",
        "Ancestral Follower", "Stormhawk Deenh", "Latenna the Albinauric",
      ];

      const runes = (Math.floor(Math.random() * 99) + 1) * 1000;
      const level = Math.floor(Math.random() * 300) + 1;

      const lines: string[] = [];

      // Grace discovered
      lines.push("                 .");
      lines.push("                ,|.");
      lines.push("               ,|||.");
      lines.push("              ,|||||.");
      lines.push("             ,|||||||");
      lines.push("            ,|||||||||");
      lines.push("                |");
      lines.push("                |");
      lines.push("            ____|____");
      lines.push("           /  GRACE  \\");
      lines.push("");
      lines.push("    ~ SITE OF GRACE DISCOVERED ~");
      lines.push("");
      lines.push(`    "${site.name}"`);
      lines.push(`    ${site.area}`);
      lines.push("");
      lines.push(`    ${site.lore}`);
      lines.push("");

      // Tarnished status
      lines.push("┌─ TARNISHED STATUS ────────────────┐");
      lines.push(`│  Level: ${String(level).padEnd(6)} Runes: ${runes.toLocaleString().padEnd(8)} │`);
      lines.push(`│  Flask: ${"█".repeat(Math.floor(Math.random() * 8) + 3)}${"░".repeat(4)}         │`);
      lines.push(`│  Spirit Ash: ${pick(ashes).padEnd(22)}│`);
      lines.push("└────────────────────────────────────┘");
      lines.push("");

      // Nearby threat
      const enemy = pick(enemies);
      const threat = pick(["roams nearby", "blocks the path ahead", "lurks in the shadows", "patrols the ruins"]);
      lines.push(`  ! ${enemy} ${threat}`);
      lines.push("");

      // Message on the ground
      lines.push(`  [ Message ] "${pick(messages)}"`);
      lines.push(`              Appraisals: ${Math.floor(Math.random() * 9999)}`);

      return { output: lines.join("\n"), type: "info" };
    },
  },
  {
    name: "skull",
    aliases: ["halo", "spartan", "chief"],
    description: "Activate a Halo Skull",
    usage: "/skull [skull-name]",
    execute: async (args) => {
      const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

      const skulls: { name: string; effect: string; flavor: string }[] = [
        { name: "Birthday Party", effect: "Grunts explode into confetti on headshot", flavor: "Yayyyy!" },
        { name: "IWHBYD", effect: "Rare combat dialogue becomes common", flavor: "I Would Have Been Your Daddy..." },
        { name: "Grunt Birthday Party", effect: "Headshot a Grunt and the whole party starts", flavor: "*confetti noises* *children cheering*" },
        { name: "Thunderstorm", effect: "All enemies are promoted one rank", flavor: "Every Elite is now a general. Good luck." },
        { name: "Blind", effect: "HUD elements are hidden", flavor: "Trust your instincts, Spartan." },
        { name: "Famine", effect: "Dropped weapons have half ammo", flavor: "Ammo doesn't grow on trees. Or Halo rings." },
        { name: "Mythic", effect: "All enemies have double health", flavor: "They just don't go down." },
        { name: "Catch", effect: "Enemies throw more grenades. Many more grenades.", flavor: "INCOMING! INCOMING! INCOMING!" },
        { name: "Iron", effect: "Death resets to last checkpoint (solo) or reverts save (co-op)", flavor: "No second chances." },
        { name: "Black Eye", effect: "Shields only recharge via melee", flavor: "Get in close, Spartan." },
        { name: "Tough Luck", effect: "Enemies always dodge grenades and vehicles", flavor: "They saw it coming." },
        { name: "Fog", effect: "Motion tracker is disabled", flavor: "Trust your eyes, not your radar." },
        { name: "Cowbell", effect: "Physics explosions are amplified 3x", flavor: "YEET." },
        { name: "Scarab", effect: "All weapons fire Scarab Gun beams", flavor: "This is technically cheating." },
        { name: "Envy", effect: "Master Chief gets permanent Active Camo", flavor: "Now you see me... no you don't." },
        { name: "Acrophobia", effect: "Press jump to fly", flavor: "Spartans weren't meant to fly. But here we are." },
      ];

      // Find by name or random
      const query = args.join(" ").trim().toLowerCase();
      const matched = query
        ? skulls.find((s) => s.name.toLowerCase().includes(query))
        : null;
      const skull = matched || pick(skulls);

      const isBirthday = skull.name.toLowerCase().includes("birthday");

      // Cortana quotes
      const cortanaLines = [
        "Chief... I'm picking up something on sensors.",
        "This cave is not a natural formation.",
        "I've run the numbers. We have a 12% chance of survival.",
        "Don't make a girl a promise you can't keep.",
        "They let me pick. Did I ever tell you that?",
        "Chief, when this is over... never mind.",
        "Scanning... I'm detecting Covenant signatures everywhere.",
        "We need to move. The Covenant won't wait.",
        "I've been thinking about what you said. About luck.",
        "Protocol dictates action. Chief, are you ready?",
      ];

      // UNSC chatter
      const unscChatter = [
        "UNSC TACCOM: All Spartans, be advised — Covenant forces inbound.",
        "UNSC TACCOM: Pelican inbound for extraction at LZ Alpha.",
        "UNSC TACCOM: Slipspace rupture detected. Multiple contacts.",
        "SGT JOHNSON: \"Dear Humanity... we regret being alien bastards.\"",
        "SGT JOHNSON: \"Send me out... with a bang.\"",
        "NOBLE SIX: \"I'm ready. How 'bout you?\"",
        "CPT KEYES: \"Cortana, all I need to know is did we lose them?\"",
        "ARBITER: \"Were it so easy.\"",
        "GRAVEMIND: \"I am a monument to all your sins.\"",
        "343 GUILTY SPARK: \"Reclaimer! You must activate the ring!\"",
      ];

      const weapons = [
        "MA5B Assault Rifle", "M6D Pistol (CE)", "BR55 Battle Rifle",
        "SRS99 Sniper Rifle", "M41 SPNKr Rocket Launcher", "Energy Sword",
        "Type-1 Plasma Grenade", "Spartan Laser", "Gravity Hammer",
        "Needler", "Fuel Rod Cannon", "DMR",
      ];

      const locations = [
        "Installation 04", "Installation 05 (Delta Halo)", "The Ark",
        "Reach", "New Mombasa", "Voi", "High Charity",
        "Requiem", "Zeta Halo", "Harvest", "Sigma Octanus IV",
        "The Pillar of Autumn", "Cairo Station", "Truth and Reconciliation",
      ];

      const shield = Math.floor(Math.random() * 8) + 1;
      const kills = Math.floor(Math.random() * 2000);

      const lines: string[] = [];

      // Skull ASCII art
      if (isBirthday) {
        lines.push("        . * .  *  . *.");
        lines.push("     *  . \\|/ .  *  .");
        lines.push("    .  *  -*-  .  * .");
        lines.push("     .  . /|\\ *  .  ");
        lines.push("      ___________");
        lines.push("     /  _     _  \\");
        lines.push("    |  |_|   |_|  |");
        lines.push("    |      _      |");
        lines.push("     \\   |___|   /");
        lines.push("      \\_________/");
        lines.push("    *  BIRTHDAY!  *");
        lines.push("   ~ confetti everywhere ~");
      } else {
        lines.push("      ___________");
        lines.push("     /           \\");
        lines.push("    |  [X]   [X]  |");
        lines.push("    |      ^      |");
        lines.push("    |    |---|    |");
        lines.push("     \\___________/");
      }
      lines.push("");

      // Skull info box
      lines.push("╔══════════════════════════════════════════════╗");
      lines.push(`║  SKULL ACTIVATED: ${skull.name.toUpperCase().padEnd(27)}║`);
      lines.push("╠══════════════════════════════════════════════╣");
      lines.push(`║  ${skull.effect.padEnd(44)}║`);
      lines.push("╚══════════════════════════════════════════════╝");
      lines.push("");
      lines.push(`  "${skull.flavor}"`);
      lines.push("");

      // MJOLNIR HUD readout
      lines.push("┌─ MJOLNIR MK VI HUD ───────────────────┐");
      lines.push(`│  SHIELD: [${"█".repeat(shield)}${"░".repeat(8 - shield)}] ${Math.floor((shield / 8) * 100)}%${" ".repeat(shield < 8 ? 13 : 12)}│`);
      lines.push(`│  WEAPON: ${pick(weapons).padEnd(30)}│`);
      lines.push(`│  LOCATION: ${pick(locations).padEnd(28)}│`);
      lines.push(`│  KILLS: ${String(kills).padEnd(31)}│`);
      lines.push(`│  DIFFICULTY: LEGENDARY ${"█".repeat(4)}          │`);
      lines.push("└─────────────────────────────────────────┘");
      lines.push("");

      // Cortana line + UNSC chatter
      lines.push(`CORTANA: "${pick(cortanaLines)}"`);
      lines.push("");
      lines.push(pick(unscChatter));
      lines.push("");

      // Sign-off
      const signoffs = [
        ">> \"Wake me... when you need me.\"",
        ">> \"Finishing this fight.\"",
        ">> \"I need a weapon.\"",
        ">> \"To give the Covenant back their bomb.\"",
        ">> \"Thought I'd try shooting my way out. Mix things up a little.\"",
        ">> \"Sir, permission to leave the station.\" \"For what purpose?\" \"To give the Covenant back their bomb.\"",
        ">> \"Don't ever let her go. Don't EVER let her go.\" — Sergeant Johnson",
        ">> Remember Reach.",
      ];
      lines.push(pick(signoffs));

      return { output: lines.join("\n"), type: "info" };
    },
  },
];

// ─── Registry helpers ────────────────────────────────────────────────────────

export function findCommand(input: string): Command | undefined {
  const name = input.toLowerCase().replace(/^\//, "");
  return commands.find(
    (c) => c.name === name || c.aliases.includes(name)
  );
}

export function getAllCommands(): Command[] {
  return commands;
}

export function parseCommandLine(line: string): { name: string; args: string[] } {
  const trimmed = line.trim().replace(/^\//, "");
  const [name, ...args] = trimmed.split(/\s+/);
  return { name: name || "", args };
}

export async function executeCommand(
  line: string,
  ctx: CommandContext
): Promise<CommandResult> {
  const { name, args } = parseCommandLine(line);
  const cmd = findCommand(name);
  if (!cmd) {
    return { output: `Unknown command: /${name}. Type /help for a list.`, type: "error" };
  }
  return cmd.execute(args, ctx);
}
