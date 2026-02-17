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
        .filter((c) => c.name !== "cowsay")
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
