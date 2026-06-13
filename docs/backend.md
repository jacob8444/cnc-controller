# CNC Backend — Raspberry Pi 3B

A production-grade Node.js backend that bridges a USB serial connection (GRBL or FluidNC) to the browser frontend over WebSockets. Designed to run 24/7 on a headless Raspberry Pi 3B.

---

## Table of Contents

1. [Hardware & OS](#1-hardware--os)
2. [Tech Stack](#2-tech-stack)
3. [Project Structure](#3-project-structure)
4. [Firmware Detection & Abstraction](#4-firmware-detection--abstraction)
5. [Serial Communication Layer](#5-serial-communication-layer)
6. [G-code Streaming Engine](#6-g-code-streaming-engine)
7. [Real-time Machine State](#7-real-time-machine-state)
8. [WebSocket Server](#8-websocket-server)
9. [REST API](#9-rest-api)
10. [Feed & Spindle Overrides](#10-feed--spindle-overrides)
11. [Camera Integration](#11-camera-integration)
12. [systemd Service](#12-systemd-service)
13. [Performance Tuning](#13-performance-tuning)
14. [Security](#14-security)

---

## 1. Hardware & OS

### Raspberry Pi 3B Specs

| Resource | Value | Notes |
|---|---|---|
| CPU | 4× ARM Cortex-A53 @ 1.2 GHz | 32-bit ARMv8 |
| RAM | 1 GB LPDDR2 | Enough — keep Node heap under 300 MB |
| USB | 4× USB 2.0 | Serial adapter plugs in here |
| Storage | microSD | Use A1/A2 rated card; consider USB SSD for writes |
| Network | 100 Mbps Ethernet, WiFi b/g/n | Use Ethernet for reliability |

### Recommended Serial Adapters

Prefer **FTDI FT232** or **CP2102** based adapters. Avoid CH340/CH341 — they have known Linux latency spikes that cause missed characters at high baud rates.

For FluidNC with ESP32, use the onboard USB or a reliable CP2102 breakout at **115200** baud (not 250000 over USB — that exceeds what most Linux USB serial drivers handle cleanly on the 3B).

### OS Setup

Use **Raspberry Pi OS Lite (64-bit)** — no desktop, minimal background processes.

```bash
# After flashing and first boot:
sudo apt update && sudo apt upgrade -y
sudo apt install -y git curl build-essential libudev-dev

# Install Node.js 20 LTS via NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Add pi user to dialout group (serial port access, no sudo needed)
sudo usermod -aG dialout pi
# Log out and back in for this to take effect

# Verify
node -v   # v20.x.x
npm -v
```

### Stable Serial Device Name (udev rule)

Without a udev rule, the serial device can appear as `/dev/ttyUSB0` or `/dev/ttyUSB1` depending on plug order. Pin it by serial number:

```bash
# Find the adapter's ID_SERIAL_SHORT
udevadm info -a -n /dev/ttyUSB0 | grep 'ATTRS{serial}'
```

```udev
# /etc/udev/rules.d/99-cnc.rules
SUBSYSTEM=="tty", ATTRS{idVendor}=="0403", ATTRS{idProduct}=="6001", ATTRS{serial}=="YOUR_SERIAL", SYMLINK+="ttyFCNC", MODE="0660", GROUP="dialout"
```

```bash
sudo udevadm control --reload-rules && sudo udevadm trigger
# Device is now always at /dev/ttyFCNC
```

---

## 2. Tech Stack

| Package | Purpose |
|---|---|
| `typescript` | Type safety throughout |
| `serialport` | USB serial communication |
| `@serialport/parser-readline` | Split stream into newline-terminated lines |
| `ws` | WebSocket server (lean, no Socket.IO overhead) |
| `express` | HTTP server for file uploads + REST |
| `multer` | Multipart file upload middleware |
| `zod` | Runtime validation of incoming WebSocket messages |
| `pino` | Fast structured logging (JSON → file, no util.format overhead) |

**Why not Python?** Node.js single-threaded event loop is ideal here — serial I/O and WebSocket I/O both fit the async model naturally, and you share TypeScript types with the frontend.

**Why not Socket.IO?** The plain `ws` library has ~3× lower memory overhead and zero protocol overhead beyond the WebSocket spec. The frontend uses native `WebSocket`.

---

## 3. Project Structure

```
cnc-backend/
├── src/
│   ├── main.ts                  # Entry point — wires everything together
│   ├── serial/
│   │   ├── SerialManager.ts     # Open/close port, raw read/write, reconnect
│   │   ├── GrblAdapter.ts       # GRBL-specific parsing and command set
│   │   ├── FluidNCAdapter.ts    # FluidNC extensions on top of GRBL base
│   │   ├── BaseAdapter.ts       # Abstract class with shared logic
│   │   └── detect.ts            # Firmware auto-detection from startup string
│   ├── streaming/
│   │   ├── Streamer.ts          # G-code streaming engine (character-count method)
│   │   └── Queue.ts             # Job queue with pause/resume/cancel
│   ├── state/
│   │   └── MachineState.ts      # Canonical machine state, emits change events
│   ├── ws/
│   │   ├── WsServer.ts          # WebSocket server + broadcast
│   │   └── MessageHandler.ts    # Incoming message router + Zod validation
│   ├── api/
│   │   ├── routes.ts            # Express routes
│   │   └── upload.ts            # G-code file upload handler
│   ├── camera/
│   │   └── CameraServer.ts      # MJPEG stream from /dev/video0
│   └── config.ts                # Typed config from env / config file
├── files/                       # Uploaded G-code files (served statically)
├── logs/                        # Pino log output
├── package.json
└── tsconfig.json
```

---

## 4. Firmware Detection & Abstraction

Both GRBL and FluidNC send a startup greeting over serial when the connection opens (or on reset). Parse this to auto-detect firmware type.

### Startup Strings

```
GRBL:    Grbl 1.1h ['$' for help]
FluidNC: FluidNC v3.7.14 [ESP32]
```

### Detection Logic

```typescript
// src/serial/detect.ts

export type FirmwareType = 'grbl' | 'fluidnc' | 'unknown'

export interface FirmwareInfo {
  type: FirmwareType
  version: string
  board?: string               // FluidNC only: "ESP32", "ESP32-S3", etc.
  raw: string
}

export function detectFirmware(line: string): FirmwareInfo | null {
  const grbl = line.match(/^Grbl\s+([\d.]+[a-z]?)/i)
  if (grbl) return { type: 'grbl', version: grbl[1], raw: line }

  const fluid = line.match(/^FluidNC\s+(v[\d.]+)(?:\s+\[([^\]]+)\])?/i)
  if (fluid) return { type: 'fluidnc', version: fluid[1], board: fluid[2], raw: line }

  return null
}
```

### Abstract Adapter

Both adapters extend a `BaseAdapter` that handles GRBL 1.1 protocol. `FluidNCAdapter` overrides only the parts that differ.

```typescript
// src/serial/BaseAdapter.ts

export abstract class BaseAdapter extends EventEmitter {
  abstract readonly firmware: FirmwareInfo

  // Override in subclass if the firmware sends extra fields
  parseStatusReport(line: string): Partial<MachineState> {
    // Parses: <Idle|MPos:0.000,0.000,0.000|WPos:0.000,0.000,0.000|FS:600,8000|Ov:100,100,100>
    const match = line.match(/^<([^|]+)\|MPos:([^|]+).*>$/)
    if (!match) return {}

    const [, stateStr, mposStr] = match
    const [mx, my, mz] = mposStr.split(',').map(Number)

    // Extract WPos if present (GRBL 1.1 may send WCO offset instead)
    const wpos = line.match(/WPos:([^|>]+)/)
    const wco  = line.match(/WCO:([^|>]+)/)
    // ... parse all fields
    return { state: parseState(stateStr), mpos: { x: mx, y: my, z: mz } }
  }

  // Real-time single-byte commands (same on both firmwares)
  cmdFeedHold()   { this.write('!') }
  cmdCycleStart() { this.write('~') }
  cmdSoftReset()  { this.write('\x18') }
  cmdStatusPoll() { this.write('?') }

  abstract write(data: string | Buffer): void
}
```

```typescript
// src/serial/FluidNCAdapter.ts

export class FluidNCAdapter extends BaseAdapter {
  // FluidNC-specific extras
  listSdFiles()        { this.write('$SD/LIST\n') }
  getConfig()          { this.write('$CD\n') }

  // FluidNC uses the same status format as GRBL 1.1
  // but may add extra fields like |SD:xx,yy| for SD progress
  parseStatusReport(line: string): Partial<MachineState> {
    const base = super.parseStatusReport(line)
    const sd = line.match(/SD:([\d.]+),([\d.]+)/)
    if (sd) base.sdProgress = { percent: Number(sd[1]), remaining: Number(sd[2]) }
    return base
  }
}
```

---

## 5. Serial Communication Layer

### SerialManager

Owns the raw `SerialPort` instance. Handles:
- Opening/closing the port
- Automatic reconnection on disconnect (essential for real workshop use)
- Feeding raw lines into the adapter

```typescript
// src/serial/SerialManager.ts
import { SerialPort } from 'serialport'
import { ReadlineParser } from '@serialport/parser-readline'

export class SerialManager extends EventEmitter {
  private port: SerialPort | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly device: string,   // e.g. '/dev/ttyFCNC'
    private readonly baud: number,     // 115200
  ) { super() }

  async open(): Promise<void> {
    this.port = new SerialPort({ path: this.device, baudRate: this.baud, autoOpen: false })
    const parser = this.port.pipe(new ReadlineParser({ delimiter: '\n' }))

    parser.on('data', (line: string) => {
      this.emit('line', line.trim())
    })

    this.port.on('close', () => {
      this.emit('disconnected')
      this.scheduleReconnect()
    })

    this.port.on('error', (err) => {
      this.emit('error', err)
      this.scheduleReconnect()
    })

    await new Promise<void>((res, rej) => {
      this.port!.open(err => err ? rej(err) : res())
    })
    this.emit('connected')
  }

  write(data: string): void {
    if (!this.port?.isOpen) return
    this.port.write(data, 'ascii')
  }

  private scheduleReconnect(delayMs = 3000) {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null
      try { await this.open() } catch { this.scheduleReconnect(5000) }
    }, delayMs)
  }

  async close() {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    await new Promise<void>(res => this.port?.close(() => res()))
    this.port = null
  }
}
```

### Key Serial Considerations on RPi 3B

**Latency** — USB serial on Linux has a default 16 ms latency timer. Reduce it:

```bash
# Run once at startup (add to systemd ExecStartPre or a udev rule)
echo 1 | sudo tee /sys/bus/usb-serial/drivers/ftdi_sio/ttyUSB0/latency_timer
```

Or set via udev so it applies automatically:
```udev
ACTION=="add", SUBSYSTEM=="usb-serial", DRIVER=="ftdi_sio", ATTR{latency_timer}="1"
```

**Buffer size** — GRBL has a **127-byte** hardware RX buffer. Never exceed this. The streaming engine (section 6) tracks this precisely.

**Flow control** — Do not enable hardware RTS/CTS flow control. GRBL/FluidNC do not use it. Software flow control (XON/XOFF) is also off.

---

## 6. G-code Streaming Engine

Naïve line-by-line (send → wait for `ok`) is safe but slow — it wastes the round-trip time. The correct approach is the **character-counting** method from the GRBL wiki.

### Character-Counting Method

Maintain a count of bytes currently "in flight" in the controller's serial buffer. Send the next line only if it fits within the 127-byte limit. Decrement on each `ok`/`error` response.

```typescript
// src/streaming/Streamer.ts

const GRBL_RX_BUFFER = 127

export type StreamerState = 'idle' | 'running' | 'paused' | 'error' | 'complete'

export class Streamer extends EventEmitter {
  private lines: string[] = []
  private sentSizes: number[] = []   // byte size of each in-flight line
  private inFlight = 0               // total bytes currently in controller buffer
  private lineIndex = 0
  private state: StreamerState = 'idle'

  constructor(private write: (line: string) => void) { super() }

  load(gcode: string) {
    this.lines = gcode
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0 && !l.startsWith(';'))
    this.lineIndex = 0
    this.inFlight = 0
    this.sentSizes = []
    this.state = 'idle'
  }

  start() {
    this.state = 'running'
    this.pump()
  }

  pause() {
    // Send real-time feed hold — controller stops motion immediately
    // Do NOT pause the ok/error counting; keep consuming responses
    this.state = 'paused'
    this.emit('stateChange', this.state)
    // Caller is responsible for sending '!' to the serial port
  }

  resume() {
    this.state = 'running'
    this.emit('stateChange', this.state)
    this.pump()
    // Caller sends '~' to resume motion
  }

  cancel() {
    this.state = 'idle'
    this.lines = []
    this.sentSizes = []
    this.inFlight = 0
    this.lineIndex = 0
    this.emit('stateChange', this.state)
    // Caller sends '\x18' (soft reset) + '$X' to unlock
  }

  // Called by SerialManager/Adapter whenever an 'ok' or 'error:X' line arrives
  onResponse(line: string) {
    if (this.state === 'idle' || this.state === 'complete') return

    // Remove the oldest in-flight line's byte count
    const size = this.sentSizes.shift()
    if (size !== undefined) this.inFlight -= size

    if (line.startsWith('error:')) {
      const errCode = parseInt(line.split(':')[1])
      this.state = 'error'
      this.emit('error', { code: errCode, lineIndex: this.lineIndex - this.sentSizes.length - 1 })
      return
    }

    this.emit('progress', {
      sent: this.lineIndex,
      total: this.lines.length,
      percent: Math.round((this.lineIndex / this.lines.length) * 100),
    })

    if (this.state === 'running') this.pump()
  }

  private pump() {
    while (this.state === 'running' && this.lineIndex < this.lines.length) {
      const line = this.lines[this.lineIndex]
      const size = line.length + 1 // +1 for '\n'

      // Stop if this line would overflow the controller buffer
      if (this.inFlight + size > GRBL_RX_BUFFER) break

      this.write(line + '\n')
      this.inFlight += size
      this.sentSizes.push(size)
      this.lineIndex++
    }

    if (this.lineIndex >= this.lines.length && this.sentSizes.length === 0) {
      this.state = 'complete'
      this.emit('stateChange', this.state)
    }
  }
}
```

### Startup Blocks

Before streaming begins, send any GRBL startup blocks ($N0 / $N1) if configured, then wait for `ok`. Only then start the Streamer.

### Comments & Line Cleaning

Strip inline comments and empty lines before loading into the streamer:

```typescript
function cleanGcode(raw: string): string[] {
  return raw
    .split('\n')
    .map(line => line.replace(/\(.*?\)/g, '').replace(/;.*$/, '').trim())
    .filter(Boolean)
}
```

---

## 7. Real-time Machine State

A single `MachineState` object is the source of truth for the frontend. It is updated from status poll responses (`?`) and broadcast to all WebSocket clients on every change.

```typescript
// src/state/MachineState.ts

export interface Vec3 { x: number; y: number; z: number }

export type GrblState =
  | 'Idle' | 'Run' | 'Hold:0' | 'Hold:1'
  | 'Jog' | 'Alarm' | 'Door:0' | 'Door:1' | 'Door:2' | 'Door:3'
  | 'Check' | 'Home' | 'Sleep'

export interface MachineState {
  // Core
  state: GrblState
  mpos: Vec3              // Machine position (absolute)
  wpos: Vec3              // Work position (MPos - WCO)
  wco: Vec3               // Work coordinate offset (active WCS)

  // Motion
  feed: number            // Current feed rate mm/min
  spindle: number         // Current spindle RPM

  // Overrides (0x90–0x9D real-time bytes reflected back in status)
  feedOverride: number    // percent, 10–200
  rapidOverride: number   // percent, 25 / 50 / 100
  spindleOverride: number // percent, 10–200

  // I/O
  pins: {
    limitX: boolean; limitY: boolean; limitZ: boolean
    probe: boolean; door: boolean; hold: boolean
  }

  // Buffer
  plannerBuffer: number   // blocks available in planner
  rxBuffer: number        // bytes available in serial RX buffer

  // Firmware
  firmware: { type: 'grbl' | 'fluidnc'; version: string; board?: string } | null

  // Streaming job
  job: {
    state: 'idle' | 'running' | 'paused' | 'error' | 'complete'
    filename: string | null
    percent: number
    linesSent: number
    totalLines: number
  }
}
```

### Status Polling

Poll at 5 Hz (every 200 ms) while running, 2 Hz (500 ms) when idle. Avoid polling faster than 10 Hz — the controller cannot keep up and will drop characters.

```typescript
class StatusPoller {
  private timer: ReturnType<typeof setInterval> | null = null

  start(machineState: MachineState, write: (s: string) => void) {
    const interval = machineState.state === 'Run' ? 200 : 500
    this.timer = setInterval(() => write('?'), interval)
  }

  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null } }
}
```

---

## 8. WebSocket Server

One WebSocket server handles all frontend clients (multiple browser tabs / devices are supported).

### Message Protocol

All messages are JSON with a `type` field. Validated with Zod on arrival.

**Server → Client (broadcast)**

```typescript
// Full state snapshot (sent on connect + on every state change)
{ type: 'state', data: MachineState }

// Incremental status update (sent on every ? poll response)
{ type: 'status', data: Partial<MachineState> }

// Console output from controller
{ type: 'console', data: { line: string; direction: 'rx' | 'tx' } }

// Streaming progress
{ type: 'progress', data: { percent: number; linesSent: number; totalLines: number } }

// Error
{ type: 'error', data: { code: string; message: string } }
```

**Client → Server**

```typescript
{ type: 'command'; data: { cmd: string } }          // Raw G-code or $ command
{ type: 'jog';     data: { axis: string; dist: number; feed: number } }
{ type: 'stream';  data: { filename: string } }     // Start streaming a file
{ type: 'pause'  }
{ type: 'resume' }
{ type: 'cancel' }
{ type: 'reset'  }
{ type: 'unlock' }                                  // $X
{ type: 'home'   }                                  // $H
{ type: 'feedOverride';    data: { value: number } }
{ type: 'spindleOverride'; data: { value: number } }
{ type: 'rapidOverride';   data: { value: number } }
{ type: 'zero'; data: { axis: 'x' | 'y' | 'z' | 'all'; wcs: string } } // G10 L20
```

### Implementation

```typescript
// src/ws/WsServer.ts
import { WebSocketServer, WebSocket } from 'ws'

export class WsServer {
  private wss: WebSocketServer
  private clients = new Set<WebSocket>()

  constructor(port: number) {
    this.wss = new WebSocketServer({ port })
    this.wss.on('connection', ws => {
      this.clients.add(ws)
      ws.on('close', () => this.clients.delete(ws))
      ws.on('message', data => this.emit('message', JSON.parse(data.toString())))
    })
  }

  broadcast(msg: object) {
    const json = JSON.stringify(msg)
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(json)
    }
  }
}
```

### Jog Handling

Jogging uses GRBL 1.1 jog mode, which is cancellable and does not enter the normal planning buffer.

```typescript
function buildJogCommand(axis: string, dist: number, feed: number): string {
  // $J= tells GRBL this is a jog (cancelled with 0x85 real-time byte)
  return `$J=G91 G21 ${axis.toUpperCase()}${dist.toFixed(4)} F${feed}\n`
}

function cancelJog(write: (s: string) => void) {
  write('\x85')   // Real-time jog cancel — stops motion, discards remaining jog moves
}
```

---

## 9. REST API

Served alongside the WebSocket on the same Express app, different port (or same port with upgrade handling).

```
GET  /api/status              Current machine state snapshot
GET  /api/files               List uploaded G-code files
POST /api/files               Upload G-code file (multipart/form-data, field: "file")
GET  /api/files/:name         Download a file
DEL  /api/files/:name         Delete a file
GET  /api/settings            Current $$ settings (GRBL) or config (FluidNC)
POST /api/settings            Write a setting ($Nnn=value)
GET  /health                  { ok: true, uptime: N }
```

### File Upload

```typescript
// src/api/upload.ts
import multer from 'multer'
import path from 'path'

const storage = multer.diskStorage({
  destination: './files',
  filename: (_req, file, cb) => {
    // Sanitise filename — never trust the client
    const safe = path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_')
    cb(null, safe)
  },
})

export const upload = multer({
  storage,
  fileFilter: (_req, file, cb) => {
    const allowed = ['.nc', '.gcode', '.g', '.tap']
    cb(null, allowed.includes(path.extname(file.originalname).toLowerCase()))
  },
  limits: { fileSize: 50 * 1024 * 1024 },   // 50 MB max
})
```

---

## 10. Feed & Spindle Overrides

GRBL/FluidNC accept real-time single-byte override commands. They take effect within one motion segment — no `\n` needed.

```typescript
// src/serial/overrides.ts

// Feed rate overrides
const FEED_OVR_RESET   = 0x90   // 100%
const FEED_OVR_PLUS10  = 0x91
const FEED_OVR_MINUS10 = 0x92
const FEED_OVR_PLUS1   = 0x93
const FEED_OVR_MINUS1  = 0x94

// Rapid overrides
const RAPID_OVR_FULL   = 0x95   // 100%
const RAPID_OVR_HALF   = 0x96   // 50%
const RAPID_OVR_QUARTER= 0x97   // 25%

// Spindle overrides
const SPINDLE_OVR_RESET   = 0x99
const SPINDLE_OVR_PLUS10  = 0x9A
const SPINDLE_OVR_MINUS10 = 0x9B
const SPINDLE_OVR_PLUS1   = 0x9C
const SPINDLE_OVR_MINUS1  = 0x9D

export function applyFeedOverride(targetPercent: number, currentPercent: number, write: (b: Buffer) => void) {
  const delta = targetPercent - currentPercent
  // Send coarse then fine adjustments
  const coarse = Math.trunc(delta / 10)
  const fine   = delta % 10
  for (let i = 0; i < Math.abs(coarse); i++)
    write(Buffer.from([coarse > 0 ? FEED_OVR_PLUS10 : FEED_OVR_MINUS10]))
  for (let i = 0; i < Math.abs(fine); i++)
    write(Buffer.from([fine > 0 ? FEED_OVR_PLUS1 : FEED_OVR_MINUS1]))
}
```

Important: track the **reflected** override values from the `Ov:` field in status reports, not the value the frontend requested. The controller is the authority.

---

## 11. Camera Integration

The RPi 3B Camera Module v2 (or any V4L2 USB camera) can stream MJPEG to the frontend.

### Option A — MJPEG via HTTP (simplest)

Use `ffmpeg` or `mjpg-streamer` as a sidecar process. The backend just spawns it.

```bash
sudo apt install -y mjpg-streamer   # or build from source for RPi cam

mjpg-streamer \
  -i "input_raspicam.so -x 1280 -y 720 -fps 15" \
  -o "output_http.so -p 8081 -w /usr/share/mjpg-streamer/www"
```

The frontend `<img>` tag points to `http://raspberrypi.local:8081/?action=stream`.

### Option B — v4l2 + sharp in Node (for timelapse frames)

```typescript
import { spawn } from 'child_process'

export function startMjpegStream(device = '/dev/video0', port = 8081) {
  const args = [
    '-f', 'v4l2', '-input_format', 'mjpeg',
    '-video_size', '1280x720', '-framerate', '15',
    '-i', device,
    '-f', 'mjpeg',
    `http://0.0.0.0:${port}/feed.mjpeg`,
  ]
  const ffmpeg = spawn('ffmpeg', args, { stdio: 'ignore' })
  ffmpeg.on('exit', code => console.log('ffmpeg exited', code))
  return ffmpeg
}
```

### Timelapse

Capture JPEG frames via V4L2 at the configured interval. Assemble with ffmpeg on job completion.

```typescript
import { execFile } from 'child_process'

function captureFrame(outputPath: string): Promise<void> {
  return new Promise((res, rej) =>
    execFile('ffmpeg', ['-f','v4l2','-i','/dev/video0','-frames:v','1',outputPath], {}, (err) =>
      err ? rej(err) : res()
    )
  )
}

async function assembleTimelapse(frameDir: string, outputPath: string, fps: number) {
  // ffmpeg -framerate 24 -i frame_%04d.jpg -c:v libx264 output.mp4
  // On RPi 3B use libx264 with -preset ultrafast to keep CPU usage bearable
}
```

---

## 12. systemd Service

Run the backend automatically on boot, restart on crash.

```ini
# /etc/systemd/system/cnc-backend.service

[Unit]
Description=CNC Backend
After=network.target dev-ttyFCNC.device
Wants=dev-ttyFCNC.device

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/cnc-backend
ExecStart=/usr/bin/node dist/main.js
Restart=on-failure
RestartSec=3
StandardOutput=append:/home/pi/cnc-backend/logs/stdout.log
StandardError=append:/home/pi/cnc-backend/logs/stderr.log

# Keep memory lean on the 3B
Environment=NODE_OPTIONS=--max-old-space-size=256

# Lower I/O priority so SD card writes don't stall serial reads
IOSchedulingClass=best-effort
IOSchedulingPriority=4

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable cnc-backend
sudo systemctl start cnc-backend
sudo journalctl -u cnc-backend -f   # follow logs
```

The `After=dev-ttyFCNC.device` line means systemd waits for the USB serial adapter to appear before starting the backend, avoiding race conditions on boot.

---

## 13. Performance Tuning

### CPU Affinity

Pin the Node.js process to a single CPU core. The event loop is single-threaded anyway, and dedicating one core avoids cache invalidation from the OS scheduler bouncing the process between cores.

```bash
# In systemd service:
ExecStart=taskset -c 0 /usr/bin/node dist/main.js
```

Leave cores 1–3 free for the OS, USB interrupts, and camera.

### SD Card Write Reduction

Avoid writing to the SD card during a job (writes block the entire I/O bus briefly on Linux):
- Log to RAM (`/tmp` is tmpfs on RPi OS by default), flush to disk only on shutdown
- Use `--max-old-space-size=256` to trigger GC before heap grows large
- Never log individual G-code lines in production

```typescript
// Use pino with async transport to batch writes
import pino from 'pino'

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport: process.env.NODE_ENV === 'production'
    ? { target: 'pino/file', options: { destination: '/tmp/cnc.log', sync: false } }
    : { target: 'pino-pretty' }
})
```

### USB Interrupt Handling

On the RPi 3B, USB is shared with Ethernet on the same root hub, which can cause jitter. If you must use a USB serial adapter and need the lowest possible latency, disable Ethernet and use WiFi instead (or get a HAT with a hardware UART).

For the hardware UART (`/dev/ttyAMA0` / `/dev/ttyS0`):
```bash
# Disable Bluetooth (which steals the hardware UART on RPi 3)
sudo systemctl disable hciuart
echo "dtoverlay=disable-bt" | sudo tee -a /boot/config.txt
# Now /dev/ttyAMA0 is free for use at true hardware UART speeds
```

### Memory

| Component | Approximate RAM |
|---|---|
| Node.js base | ~30 MB |
| ws connections (10 clients) | ~2 MB |
| G-code file in memory (50 MB file) | ~50 MB |
| Streaming engine state | <1 MB |
| Total typical | ~90–120 MB |

The 1 GB of RPi 3B RAM is more than sufficient. Set `--max-old-space-size=256` as a safety cap.

---

## 14. Security

This backend is intended for a **trusted local network only** (your workshop). Do not expose it to the internet.

### Authentication

Add a simple shared secret token checked on WebSocket upgrade and on every REST request:

```typescript
// WS upgrade check
wss.on('headers', (headers, req) => {
  const token = new URL(req.url!, 'http://x').searchParams.get('token')
  if (token !== process.env.AUTH_TOKEN) {
    // ws library closes the socket after this callback if we throw
    throw new Error('Unauthorized')
  }
})

// Express middleware
app.use((req, res, next) => {
  const token = req.headers['x-auth-token'] ?? req.query.token
  if (token !== process.env.AUTH_TOKEN) return res.status(401).json({ error: 'Unauthorized' })
  next()
})
```

The frontend passes `ws://raspberrypi.local:8080/?token=YOUR_TOKEN` and adds `X-Auth-Token` to all fetch calls.

### CORS

Restrict CORS to your frontend origin in production:

```typescript
app.use(cors({
  origin: process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173',
  methods: ['GET', 'POST', 'DELETE'],
}))
```

### File Path Validation

Never trust filenames from the client:

```typescript
function safeFilePath(base: string, name: string): string {
  const resolved = path.resolve(base, path.basename(name))
  if (!resolved.startsWith(path.resolve(base))) throw new Error('Path traversal detected')
  return resolved
}
```

### Rate Limiting

Limit command throughput to prevent accidental G-code floods:

```typescript
// Allow at most 200 commands/second from any single client
// (well above any human or reasonable automation rate)
const commandCounts = new Map<WebSocket, number>()
setInterval(() => commandCounts.clear(), 1000)

function checkRate(ws: WebSocket): boolean {
  const count = (commandCounts.get(ws) ?? 0) + 1
  commandCounts.set(ws, count)
  return count <= 200
}
```

---

## Quick-start Summary

```bash
# 1. Clone and install
git clone https://github.com/your/cnc-backend && cd cnc-backend
npm install

# 2. Configure
cp .env.example .env
# Edit: SERIAL_PORT=/dev/ttyFCNC, BAUD=115200, AUTH_TOKEN=changeme, WS_PORT=8080

# 3. Build and run
npm run build
node dist/main.js

# 4. Install as service
sudo cp cnc-backend.service /etc/systemd/system/
sudo systemctl enable --now cnc-backend
```

The frontend connects to `ws://raspberrypi.local:8080/?token=YOUR_TOKEN` and the REST API is at `http://raspberrypi.local:8080/api`.

---

*Last updated: 2026-06-13*
