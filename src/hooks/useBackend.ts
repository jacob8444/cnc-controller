import { useState, useEffect, useRef, useCallback } from 'react'

// ── Types (mirrors backend src/types.ts) ──────────────────────────────────────

export interface Vec3 { x: number; y: number; z: number }

export type GrblState =
  | 'Idle' | 'Run' | 'Hold' | 'Jog'
  | 'Alarm' | 'Door' | 'Check' | 'Home' | 'Sleep'

export interface FirmwareInfo {
  type: 'grbl' | 'fluidnc'
  version: string
  board?: string
}

export interface MachineStatus {
  connected:       boolean
  firmware:        FirmwareInfo | null
  state:           GrblState | null
  mpos:            Vec3
  wpos:            Vec3
  wco:             Vec3
  feed:            number
  spindle:         number
  feedOverride:    number
  rapidOverride:   number
  spindleOverride: number
  pins:   { limitX: boolean; limitY: boolean; limitZ: boolean; probe: boolean }
  buffer: { planner: number; rx: number }
  job: {
    state:      'idle' | 'running' | 'paused' | 'complete' | 'error'
    filename:   string | null
    percent:    number
    linesSent:  number
    totalLines: number
  }
}

export interface SysMetrics {
  cpu: number; temp: number; ramUsed: number; ramTotal: number; load1: number
}

export interface WsConsoleEntry { dir: 'rx' | 'tx'; line: string }

type ServerMessage =
  | { type: 'state';      data: MachineStatus }
  | { type: 'status';     data: Partial<MachineStatus> }
  | { type: 'console';    data: WsConsoleEntry }
  | { type: 'sysmetrics'; data: SysMetrics }
  | { type: 'firmware';   data: FirmwareInfo }
  | { type: 'error';      data: { code: string; message: string } }
  | { type: 'files';      data: string[] }
  | { type: 'progress';   data: { percent: number; linesSent: number; totalLines: number } }

export type ClientMessage =
  | { type: 'command';        data: { cmd: string } }
  | { type: 'jog';            data: { axis: string; dist: number; feed: number } }
  | { type: 'stream';         data: { filename: string } }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'cancel' }
  | { type: 'reset' }
  | { type: 'unlock' }
  | { type: 'home' }
  | { type: 'feedOverride';    data: { value: number } }
  | { type: 'spindleOverride'; data: { value: number } }
  | { type: 'rapidOverride';   data: { value: 25 | 50 | 100 } }
  | { type: 'zero';            data: { axis: 'x' | 'y' | 'z' | 'all'; wcs: string } }

// ── Defaults ──────────────────────────────────────────────────────────────────

export const DEFAULT_STATUS: MachineStatus = {
  connected: false,
  firmware:  null,
  state:     null,
  mpos:      { x: 0, y: 0, z: 0 },
  wpos:      { x: 0, y: 0, z: 0 },
  wco:       { x: 0, y: 0, z: 0 },
  feed:      0,
  spindle:   0,
  feedOverride:    100,
  rapidOverride:   100,
  spindleOverride: 100,
  pins:   { limitX: false, limitY: false, limitZ: false, probe: false },
  buffer: { planner: 0, rx: 0 },
  job:    { state: 'idle', filename: null, percent: 0, linesSent: 0, totalLines: 0 },
}

const MAX_CONSOLE = 500

// ── Hook ──────────────────────────────────────────────────────────────────────

/**
 * Manages the WebSocket connection to the CNC backend.
 * Pass url=null to stay disconnected; set a url string to connect.
 * Reconnects automatically with exponential backoff (3s → 30s cap).
 */
export function useBackend(url: string | null) {
  const [wsOpen, setWsOpen]     = useState(false)
  const [status, setStatus]     = useState<MachineStatus>(DEFAULT_STATUS)
  const [metrics, setMetrics]   = useState<SysMetrics | null>(null)
  const [wsConsole, setConsole] = useState<WsConsoleEntry[]>([])
  const [files, setFiles]       = useState<string[]>([])

  const wsRef      = useRef<WebSocket | null>(null)
  const timerRef   = useRef<ReturnType<typeof setTimeout> | null>(null)
  const delayRef   = useRef(3000)
  const stoppedRef = useRef(false)

  const send = useCallback((msg: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg))
    }
  }, [])

  const pushLine = (entry: WsConsoleEntry) =>
    setConsole(prev =>
      prev.length >= MAX_CONSOLE
        ? [...prev.slice(-(MAX_CONSOLE - 1)), entry]
        : [...prev, entry],
    )

  useEffect(() => {
    if (!url) {
      stoppedRef.current = true
      if (timerRef.current) clearTimeout(timerRef.current)
      wsRef.current?.close()
      wsRef.current = null
      setWsOpen(false)
      setStatus(DEFAULT_STATUS)
      setMetrics(null)
      return
    }

    stoppedRef.current = false
    delayRef.current = 3000

    function connect() {
      if (stoppedRef.current) return
      const ws = new WebSocket(url!)
      wsRef.current = ws

      ws.onopen = () => {
        if (stoppedRef.current) { ws.close(); return }
        setWsOpen(true)
        delayRef.current = 3000
      }

      ws.onmessage = (e: MessageEvent) => {
        let msg: ServerMessage
        try { msg = JSON.parse(e.data as string) } catch { return }

        switch (msg.type) {
          case 'state':
            setStatus(msg.data)
            break
          case 'status':
            setStatus(prev => ({ ...prev, ...msg.data } as MachineStatus))
            break
          case 'sysmetrics':
            setMetrics(msg.data)
            break
          case 'console':
            pushLine(msg.data)
            break
          case 'firmware':
            setStatus(prev => ({ ...prev, firmware: msg.data }))
            break
          case 'error':
            pushLine({ dir: 'rx', line: `ERROR ${msg.data.code}: ${msg.data.message}` })
            break
          case 'files':
            setFiles(msg.data)
            break
          case 'progress':
            setStatus(prev => ({ ...prev, job: { ...prev.job, ...msg.data } }))
            break
        }
      }

      const onClose = () => {
        setWsOpen(false)
        if (!stoppedRef.current) {
          timerRef.current = setTimeout(() => {
            delayRef.current = Math.min(delayRef.current * 1.5, 30_000)
            connect()
          }, delayRef.current)
        }
      }
      ws.onclose = onClose
      ws.onerror = () => ws.close()
    }

    connect()

    return () => {
      stoppedRef.current = true
      if (timerRef.current) clearTimeout(timerRef.current)
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [url])

  return { wsOpen, status, metrics, wsConsole, files, send }
}
