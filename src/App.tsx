import { useState, useEffect, useRef, useCallback } from 'react'
import { useBackend } from '@/hooks/useBackend'
import { Joystick, Camera, FileCode2, Play, Pause, Square, Wrench, Home, RotateCcw, Target, Circle, Folder, Download, Trash2, FolderOpen, ChevronDown, Send, Plus, Pencil, AlertTriangle, X, Plug, PlugZap, Keyboard } from 'lucide-react'
import { ConfirmModal } from '@/components/ConfirmModal'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { GCodeVisualizer, type GCodeStats } from '@/components/GCodeVisualizer'

type Tab = 'control' | 'camera' | 'program' | 'probe' | 'toolchange'
type ModalKey = 'run' | 'xy0' | 'z0' | 'stop' | null
type MachineState = 'idle' | 'running' | 'paused'

const tabs: { id: Tab; label: string; icon: typeof Joystick }[] = [
  { id: 'control', label: 'Control', icon: Joystick },
  { id: 'camera', label: 'Camera', icon: Camera },
  { id: 'program', label: 'Program', icon: FileCode2 },
  { id: 'probe', label: 'Probe', icon: Target },
  { id: 'toolchange', label: 'Tool', icon: Wrench },
]

const MODALS: Record<Exclude<ModalKey, null>, { title: string; description: string; confirmLabel: string; cancelLabel?: string; destructive?: boolean }> = {
  run: {
    title: 'Run Program',
    description: 'Start executing the loaded G-code program. Make sure the workpiece and tool are correctly set up.',
    confirmLabel: 'Run',
  },
  xy0: {
    title: 'Go to XY Zero',
    description: 'Move the machine to X0 Y0 of the active work coordinate system.',
    confirmLabel: 'Go',
  },
  z0: {
    title: 'Go to Z Zero',
    description: 'Move the machine to Z0 of the active work coordinate system.',
    confirmLabel: 'Go',
  },
  stop: {
    title: 'Stop Program',
    description: 'The machine has been paused. Confirming will stop the program and reset the run state.',
    confirmLabel: 'Stop',
    cancelLabel: 'Pause',
    destructive: true,
  },
}

const WCS_OPTIONS = ['G54', 'G55', 'G56', 'G57', 'G58', 'G59'] as const
type WCSOption = typeof WCS_OPTIONS[number]

function DRO({
  onZero,
  wpos = { x: 0, y: 0, z: 0 },
  mpos = { x: 0, y: 0, z: 0 },
}: {
  onZero?: (wcs: WCSOption, axis: 'X' | 'Y' | 'Z') => void
  wpos?: { x: number; y: number; z: number }
  mpos?: { x: number; y: number; z: number }
}) {
  const [activeWCS, setActiveWCS] = useState<WCSOption>('G54')
  const axes = [
    { label: 'X', wcs: wpos.x.toFixed(3), mcs: mpos.x.toFixed(3) },
    { label: 'Y', wcs: wpos.y.toFixed(3), mcs: mpos.y.toFixed(3) },
    { label: 'Z', wcs: wpos.z.toFixed(3), mcs: mpos.z.toFixed(3) },
  ]
  return (
    <div className="bg-card border-b px-4 py-3 flex flex-col gap-2">
      <div className="flex gap-1">
        {WCS_OPTIONS.map(wcs => (
          <button
            key={wcs}
            onClick={() => setActiveWCS(wcs)}
            className={`flex-1 py-1 rounded text-xs font-medium transition-colors ${
              activeWCS === wcs ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground'
            }`}
          >
            {wcs}
          </button>
        ))}
      </div>
      <div className="flex flex-col gap-1.5">
        {axes.map(({ label, wcs, mcs }) => (
          <div key={label} className="flex items-stretch gap-2">
            <button
              onClick={() => onZero?.(activeWCS, label as 'X' | 'Y' | 'Z')}
              className="w-16 bg-muted rounded-lg text-xs font-semibold text-muted-foreground active:bg-muted-foreground/20 transition-colors py-2 shrink-0">
              Zero {label}
            </button>
            <div className="flex-1 flex items-center bg-muted rounded-lg px-3 py-2 gap-3 min-w-0">
              <span className="text-xs font-medium text-muted-foreground w-3 shrink-0">{label}</span>
              <div className="flex-1 flex items-baseline justify-end gap-1">
                <span className="text-xs text-muted-foreground">WCS</span>
                <span className="font-mono text-lg font-semibold tracking-tight">{wcs}</span>
              </div>
              <div className="flex-1 flex items-baseline justify-end gap-1">
                <span className="text-xs text-muted-foreground">MCS</span>
                <span className="font-mono text-lg text-muted-foreground">{mcs}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function JogButton({ children, className = '', onClick }: { children: React.ReactNode; className?: string; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`bg-muted rounded-xl flex items-center justify-center active:bg-muted-foreground/20 transition-colors ${className}`}
    >
      {children}
    </button>
  )
}

const FEEDRATES = [100, 200, 300, 500, 1000, 1500, 2000, 2500]
const JOG_AMOUNTS = [0.01, 0.02, 0.03, 0.05, 0.1, 0.2, 0.3, 0.5, 1, 2, 3, 5, 10, 20, 30, 50, 100, 200, 300]

function ScrollSelector<T extends number>({
  options,
  value,
  onChange,
  format,
}: {
  options: T[]
  value: T
  onChange: (v: T) => void
  format: (v: T) => string
}) {
  return (
    <div className="overflow-x-auto scrollbar-none w-full min-w-0">
      <div className="flex gap-1.5 px-4" style={{ width: 'max-content' }}>
        {options.map(o => (
          <button
            key={o}
            onClick={() => onChange(o)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors ${
              value === o ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground'
            }`}
          >
            {format(o)}
          </button>
        ))}
      </div>
    </div>
  )
}

function JogInterface({
  onConfirm,
  onJog,
  feedrate: feedrateProp,
  jogAmount: jogAmountProp,
  onFeedrateChange,
  onJogAmountChange,
}: {
  onConfirm: (key: ModalKey) => void
  onJog?: (axis: string, dist: number, feed: number) => void
  feedrate?: number
  jogAmount?: number
  onFeedrateChange?: (v: number) => void
  onJogAmountChange?: (v: number) => void
}) {
  const [localFeedrate, setLocalFeedrate] = useState(500)
  const [localJogAmount, setLocalJogAmount] = useState(1)
  const feedrate  = feedrateProp  ?? localFeedrate
  const jogAmount = jogAmountProp ?? localJogAmount
  const setFeedrate  = onFeedrateChange  ?? setLocalFeedrate
  const setJogAmount = onJogAmountChange ?? setLocalJogAmount

  const jog = (axis: string, sign: 1 | -1) => onJog?.(axis, sign * jogAmount, feedrate)

  return (
    <div className="flex-1 flex flex-col justify-center gap-2 py-2 overflow-hidden min-h-0">
      <ScrollSelector
        options={FEEDRATES}
        value={feedrate}
        onChange={onFeedrateChange}
        format={v => `${v} mm/min`}
      />

      <div className="px-4 pt-6 pb-6 w-full">
        <div className="grid gap-1.5 w-full" style={{ gridTemplateColumns: 'repeat(5, 1fr)', gridTemplateRows: 'repeat(3, 1fr)', aspectRatio: '5/3' }}>
          {/* Row 1 */}
          <div />
          <JogButton onClick={() => jog('Y', 1)}><span className="text-xs font-semibold">Y+</span></JogButton>
          <div />
          <div />
          <JogButton onClick={() => jog('Z', 1)}><span className="text-xs font-semibold">Z+</span></JogButton>

          {/* Row 2 */}
          <JogButton onClick={() => jog('X', -1)}><span className="text-xs font-semibold">X−</span></JogButton>
          <JogButton onClick={() => onConfirm('xy0')}>
            <span className="text-xs font-semibold text-muted-foreground">XY0</span>
          </JogButton>
          <JogButton onClick={() => jog('X', 1)}><span className="text-xs font-semibold">X+</span></JogButton>
          <div />
          <JogButton onClick={() => onConfirm('z0')}>
            <span className="text-xs font-semibold text-muted-foreground">Z0</span>
          </JogButton>

          {/* Row 3 */}
          <div />
          <JogButton onClick={() => jog('Y', -1)}><span className="text-xs font-semibold">Y−</span></JogButton>
          <div />
          <div />
          <JogButton onClick={() => jog('Z', -1)}><span className="text-xs font-semibold">Z−</span></JogButton>
        </div>
      </div>

      <ScrollSelector
        options={JOG_AMOUNTS}
        value={jogAmount}
        onChange={onJogAmountChange}
        format={v => `${v} mm`}
      />
    </div>
  )
}

function MachineActions({
  machineState,
  onConfirm,
  onStop,
  onPauseResume,
  onHome,
  onReset,
  onUnlock,
}: {
  machineState: MachineState
  onConfirm: (key: ModalKey) => void
  onStop: () => void
  onPauseResume: () => void
  onHome?: () => void
  onReset?: () => void
  onUnlock?: () => void
}) {
  const isPaused = machineState === 'paused'

  const actions: { label: string; icon: typeof Play; className: string; onClick: () => void }[] = [
    { label: 'Run', icon: Play, className: 'text-green-500', onClick: () => onConfirm('run') },
    { label: isPaused ? 'Continue' : 'Pause', icon: isPaused ? Play : Pause, className: isPaused ? 'text-green-500' : '', onClick: onPauseResume },
    { label: 'Stop', icon: Square, className: 'text-red-500', onClick: onStop },
    { label: 'Home', icon: Home, className: '', onClick: () => onHome?.() },
    { label: 'Reset', icon: RotateCcw, className: '', onClick: () => onReset?.() },
  ]
  return (
    <div className="border-t bg-background flex">
      {actions.map(({ label, icon: Icon, className, onClick }) => (
        <button
          key={label}
          onClick={onClick}
          className="flex-1 min-w-0 flex flex-col items-center gap-1 py-3 text-xs text-muted-foreground transition-colors active:text-foreground"
        >
          <Icon size={22} className={className} />
          <span>{label}</span>
        </button>
      ))}
    </div>
  )
}

function ControlScreen({
  machineState,
  onConfirm,
  onStop,
  onPauseResume,
}: {
  machineState: MachineState
  onConfirm: (key: ModalKey) => void
  onStop: () => void
  onPauseResume: () => void
}) {
  return (
    <>
      <DRO />
      <JogInterface onConfirm={onConfirm} />
      <MachineActions machineState={machineState} onConfirm={onConfirm} onStop={onStop} onPauseResume={onPauseResume} />
    </>
  )
}

const TIMELAPSE_FPS = [1, 2, 3, 4, 5]

type TimelapseState = 'idle' | 'recording' | 'paused'

interface TimelapseEntry {
  id: string
  name: string
  duration: string
  size: string
  date: string
}

const MOCK_TIMELAPSES: TimelapseEntry[] = [
  { id: '1', name: 'Job_2024-06-12_01', duration: '0:42', size: '18 MB', date: 'Jun 12' },
  { id: '2', name: 'Job_2024-06-11_02', duration: '1:15', size: '31 MB', date: 'Jun 11' },
  { id: '3', name: 'Job_2024-06-10_01', duration: '0:28', size: '12 MB', date: 'Jun 10' },
]

function CameraScreen({
  machineState,
  onConfirm,
  onStop,
  onPauseResume,
}: {
  machineState: MachineState
  onConfirm: (key: ModalKey) => void
  onStop: () => void
  onPauseResume: () => void
}) {
  const [tlState, setTlState] = useState<TimelapseState>('idle')
  const [fps, setFps] = useState(1)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [timelapses, setTimelapses] = useState<TimelapseEntry[]>(MOCK_TIMELAPSES)

  return (
    <>
      {/* Status bar */}
      <div className="bg-card border-b px-4 py-3 flex items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-muted-foreground/40 shrink-0" />
          <span className="text-xs text-muted-foreground">Idle</span>
        </div>
        <div className="h-3 w-px bg-border" />
        <span className="text-xs text-muted-foreground">No program loaded</span>
        <div className="ml-auto flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Feed</span>
          <span className="text-xs font-mono font-semibold">0 mm/min</span>
        </div>
      </div>

      {/* Camera feed */}
      <div className="px-4 pt-4">
        <div className="w-full bg-muted rounded-xl overflow-hidden" style={{ aspectRatio: '4/3' }}>
          <div className="w-full h-full flex items-center justify-center">
            <span className="text-xs text-muted-foreground">No camera feed</span>
          </div>
        </div>
      </div>

      {/* Timelapse controls */}
      <div className="flex-1 flex flex-col justify-end px-4 pb-4 gap-4 pt-4">
        {/* FPS row */}
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground shrink-0">FPS</span>
          <div className="overflow-x-auto scrollbar-none min-w-0">
            <div className="flex gap-1.5" style={{ width: 'max-content' }}>
              {TIMELAPSE_FPS.map(f => (
                <button
                  key={f}
                  onClick={() => setFps(f)}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors ${
                    fps === f ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {f}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Record controls */}
        <div className="flex items-center gap-2">
          {tlState === 'idle' && (
            <button
              onClick={() => setTlState('recording')}
              className="flex-1 flex items-center justify-center gap-2 bg-red-500 text-white rounded-xl py-3 text-sm font-semibold active:opacity-80 transition-opacity"
            >
              <Circle size={16} className="fill-white" />
              Record
            </button>
          )}
          {tlState === 'recording' && (
            <>
              <button
                onClick={() => setTlState('paused')}
                className="flex-1 flex items-center justify-center gap-2 bg-muted rounded-xl py-3 text-sm font-semibold active:opacity-80 transition-opacity"
              >
                <Pause size={16} />
                Pause
              </button>
              <button
                onClick={() => setTlState('idle')}
                className="flex-1 flex items-center justify-center gap-2 bg-muted rounded-xl py-3 text-sm font-semibold text-red-500 active:opacity-80 transition-opacity"
              >
                <Square size={16} />
                Stop
              </button>
            </>
          )}
          {tlState === 'paused' && (
            <>
              <button
                onClick={() => setTlState('recording')}
                className="flex-1 flex items-center justify-center gap-2 bg-muted rounded-xl py-3 text-sm font-semibold text-green-500 active:opacity-80 transition-opacity"
              >
                <Play size={16} />
                Resume
              </button>
              <button
                onClick={() => setTlState('idle')}
                className="flex-1 flex items-center justify-center gap-2 bg-muted rounded-xl py-3 text-sm font-semibold text-red-500 active:opacity-80 transition-opacity"
              >
                <Square size={16} />
                Stop
              </button>
            </>
          )}
          <button
            onClick={() => setLibraryOpen(true)}
            className="bg-muted rounded-xl p-3 active:opacity-80 transition-opacity shrink-0"
          >
            <Folder size={20} />
          </button>
        </div>
      </div>

      <MachineActions machineState={machineState} onConfirm={onConfirm} onStop={onStop} onPauseResume={onPauseResume} />

      {/* Timelapse library modal */}
      <Dialog open={libraryOpen} onOpenChange={setLibraryOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Timelapses</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-2 max-h-72 overflow-y-auto">
            {timelapses.length === 0 && (
              <p className="text-xs text-muted-foreground text-center py-6">No timelapses yet</p>
            )}
            {timelapses.map(tl => (
              <div key={tl.id} className="flex items-center gap-3 bg-muted rounded-lg px-3 py-2.5">
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium truncate">{tl.name}</p>
                  <p className="text-xs text-muted-foreground">{tl.date} · {tl.duration} · {tl.size}</p>
                </div>
                <div className="flex gap-1 shrink-0">
                  <button className="p-1.5 rounded-lg hover:bg-background transition-colors">
                    <Play size={14} />
                  </button>
                  <button className="p-1.5 rounded-lg hover:bg-background transition-colors">
                    <Download size={14} />
                  </button>
                  <button
                    onClick={() => setTimelapses(prev => prev.filter(t => t.id !== tl.id))}
                    className="p-1.5 rounded-lg hover:bg-background transition-colors text-red-500"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

function ProgramScreen({
  machineState, onConfirm, onStop, onPauseResume,
  gcode, filename, onGcodeChange,
}: {
  machineState: MachineState
  onConfirm: (key: ModalKey) => void
  onStop: () => void
  onPauseResume: () => void
  gcode: string | null
  filename: string | null
  onGcodeChange: (gcode: string | null, filename: string | null) => void
}) {
  const [stats, setStats] = useState<GCodeStats | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = ev => onGcodeChange(ev.target?.result as string, file.name)
    reader.readAsText(file)
  }

  const formatTime = (s: number) => {
    if (!s) return '—'
    const m = Math.floor(s / 60), sec = Math.round(s % 60)
    return m > 0 ? `${m}m ${sec}s` : `${sec}s`
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Header */}
      <div className="bg-card border-b px-4 py-3 flex items-center gap-3">
        <button
          onClick={() => fileRef.current?.click()}
          className="flex items-center gap-2 bg-muted rounded-lg px-3 py-1.5 text-xs font-medium active:opacity-70 transition-opacity shrink-0"
        >
          <FolderOpen size={14} />
          Load
        </button>
        <span className="text-xs text-muted-foreground truncate min-w-0">
          {filename ?? 'No file loaded'}
        </span>
        <input ref={fileRef} type="file" accept=".nc,.gcode,.g,.tap" className="hidden" onChange={handleFile} />
      </div>

      {/* Visualizer */}
      <div className="px-4 pt-4">
        <div className="w-full rounded-xl overflow-hidden bg-[#fafafa] border" style={{ aspectRatio: '4/3' }}>
          <GCodeVisualizer gcode={gcode} onStats={setStats} />
        </div>
      </div>

      {/* Stats */}
      <div className="px-4 py-2">
        {!gcode ? (
          <p className="text-xs text-muted-foreground text-center py-1">Load a G-code file to see stats</p>
        ) : (
          <div className="grid grid-cols-4 gap-1.5">
            {[
              { label: 'Lines', value: stats?.lineCount?.toLocaleString() ?? '—' },
              { label: 'Time', value: formatTime(stats?.estimatedTime ?? 0) },
              { label: 'Rapid', value: stats?.rapidCount?.toLocaleString() ?? '—' },
              { label: 'Cut', value: stats?.cutCount?.toLocaleString() ?? '—' },
              { label: 'X', value: stats?.bounds ? `${(stats.bounds.max.x - stats.bounds.min.x).toFixed(1)}` : '—' },
              { label: 'Y', value: stats?.bounds ? `${(stats.bounds.max.y - stats.bounds.min.y).toFixed(1)}` : '—' },
              { label: 'Z', value: stats?.bounds ? `${(stats.bounds.max.z - stats.bounds.min.z).toFixed(1)}` : '—' },
              { label: 'Z min', value: stats?.bounds ? `${stats.bounds.min.z.toFixed(1)}` : '—' },
            ].map(({ label, value }) => (
              <div key={label} className="bg-muted rounded-lg px-2 py-1.5">
                <p className="text-[10px] text-muted-foreground leading-none mb-0.5">{label}</p>
                <p className="text-xs font-semibold font-mono truncate">{value}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex-1" />
      <MachineActions machineState={machineState} onConfirm={onConfirm} onStop={onStop} onPauseResume={onPauseResume} />
    </div>
  )
}

type ProbeOp = 'x-' | 'x+' | 'y-' | 'y+' | 'corner-tl' | 'corner-tr' | 'corner-bl' | 'corner-br' | 'center-xy' | 'z' | 'hole-in' | 'hole-out'

interface ProbeOpDef {
  title: string
  desc: string
  confirmDesc: string
  group: string
}

const PROBE_OPS: Record<ProbeOp, ProbeOpDef> = {
  'z':         { group: 'Z Axis',    title: 'Surface Z',        desc: 'Probe top of stock and set Z zero',                     confirmDesc: 'The probe will descend until it touches the stock surface, then set Z zero offset by the probe radius.' },
  'x-':        { group: 'XY Edges',  title: 'Edge X−',          desc: 'Touch left face, set X zero at edge',                   confirmDesc: 'The probe will move in the X− direction until it contacts the stock, then offset X zero by the probe radius.' },
  'x+':        { group: 'XY Edges',  title: 'Edge X+',          desc: 'Touch right face, set X zero at edge',                  confirmDesc: 'The probe will move in the X+ direction until it contacts the stock, then offset X zero by the probe radius.' },
  'y-':        { group: 'XY Edges',  title: 'Edge Y−',          desc: 'Touch front face, set Y zero at edge',                  confirmDesc: 'The probe will move in the Y− direction until it contacts the stock, then offset Y zero by the probe radius.' },
  'y+':        { group: 'XY Edges',  title: 'Edge Y+',          desc: 'Touch back face, set Y zero at edge',                   confirmDesc: 'The probe will move in the Y+ direction until it contacts the stock, then offset Y zero by the probe radius.' },
  'corner-tl': { group: 'XY Corners',title: 'Corner X− Y+',     desc: 'Probe left and back faces, set XY zero at corner',      confirmDesc: 'The probe will touch the X− face then the Y+ face and set the corner as XY zero, offset by probe radius on both axes.' },
  'corner-tr': { group: 'XY Corners',title: 'Corner X+ Y+',     desc: 'Probe right and back faces, set XY zero at corner',     confirmDesc: 'The probe will touch the X+ face then the Y+ face and set the corner as XY zero, offset by probe radius on both axes.' },
  'corner-bl': { group: 'XY Corners',title: 'Corner X− Y−',     desc: 'Probe left and front faces, set XY zero at corner',     confirmDesc: 'The probe will touch the X− face then the Y− face and set the corner as XY zero, offset by probe radius on both axes.' },
  'corner-br': { group: 'XY Corners',title: 'Corner X+ Y−',     desc: 'Probe right and front faces, set XY zero at corner',    confirmDesc: 'The probe will touch the X+ face then the Y− face and set the corner as XY zero, offset by probe radius on both axes.' },
  'center-xy': { group: 'XY Center', title: 'Center XY',        desc: 'Probe all 4 faces, set center as XY zero',              confirmDesc: 'The probe will touch all four sides of the stock and calculate the center, setting it as XY zero.' },
  'hole-in':   { group: 'Circular',  title: 'Inside Circle',    desc: 'Probe inside of a bore, set center as XY zero',         confirmDesc: 'The probe will touch 4 points on the bore wall to find the exact center and set it as XY zero.' },
  'hole-out':  { group: 'Circular',  title: 'Outside Circle',   desc: 'Probe outside of a boss or cylinder, set center as XY zero', confirmDesc: 'The probe will touch 4 points around the outside of the boss to find the exact center and set it as XY zero.' },
}

const PROBE_GROUPS = ['Z Axis', 'XY Edges', 'XY Corners', 'XY Center', 'Circular']

const PROBE_FEEDRATES = [10, 20, 50, 100, 200]

function ProbeScreen({
  machineState,
  onConfirm,
  onStop,
  onPauseResume,
}: {
  machineState: MachineState
  onConfirm: (key: ModalKey) => void
  onStop: () => void
  onPauseResume: () => void
}) {
  const [probeDia, setProbeDia] = useState('4.0')
  const [retract, setRetract] = useState('2.0')
  const [feedrate, setFeedrate] = useState(50)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [pendingOp, setPendingOp] = useState<ProbeOp | null>(null)

  const groupedOps = PROBE_GROUPS.map(group => ({
    group,
    ops: (Object.entries(PROBE_OPS) as [ProbeOp, ProbeOpDef][]).filter(([, def]) => def.group === group),
  }))

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Settings bar */}
      <div className="bg-card border-b px-4 py-2">
        <button
          onClick={() => setSettingsOpen(v => !v)}
          className="flex items-center gap-2 w-full"
        >
          <span className="text-xs font-medium">Probe Settings</span>
          <span className="text-xs text-muted-foreground ml-1">⌀{probeDia} mm · {feedrate} mm/min · {retract} mm retract</span>
          <ChevronDown size={14} className={`ml-auto shrink-0 transition-transform ${settingsOpen ? 'rotate-180' : ''}`} />
        </button>
        {settingsOpen && (
          <div className="mt-3 flex flex-col gap-3 pb-1">
            <div className="flex gap-3">
              <label className="flex-1 flex flex-col gap-1">
                <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Probe dia (mm)</span>
                <input
                  type="number"
                  value={probeDia}
                  onChange={e => setProbeDia(e.target.value)}
                  step="0.1"
                  className="bg-muted rounded-lg px-3 py-2 text-sm font-mono w-full"
                />
              </label>
              <label className="flex-1 flex flex-col gap-1">
                <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Retract (mm)</span>
                <input
                  type="number"
                  value={retract}
                  onChange={e => setRetract(e.target.value)}
                  step="0.5"
                  className="bg-muted rounded-lg px-3 py-2 text-sm font-mono w-full"
                />
              </label>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Feedrate</span>
              <ScrollSelector options={PROBE_FEEDRATES} value={feedrate} onChange={setFeedrate} format={v => `${v} mm/min`} />
            </div>
          </div>
        )}
      </div>

      {/* Operation list */}
      <div className="flex-1 overflow-y-auto min-h-0 px-4 py-3 flex flex-col gap-4">
        {groupedOps.map(({ group, ops }) => (
          <div key={group} className="flex flex-col gap-1.5">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide px-1">{group}</p>
            {ops.map(([key, def]) => (
              <button
                key={key}
                onClick={() => setPendingOp(key)}
                className="w-full flex items-center gap-3 bg-muted rounded-xl px-4 py-3 text-left active:bg-muted-foreground/20 transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold">{def.title}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{def.desc}</p>
                </div>
                <span className="text-muted-foreground text-lg shrink-0">›</span>
              </button>
            ))}
          </div>
        ))}
      </div>

      <MachineActions machineState={machineState} onConfirm={onConfirm} onStop={onStop} onPauseResume={onPauseResume} />

      {pendingOp && (
        <ConfirmModal
          open
          title={`Run: ${PROBE_OPS[pendingOp].title}`}
          description={PROBE_OPS[pendingOp].confirmDesc}
          confirmLabel="Run Probe Cycle"
          onConfirm={() => { setPendingOp(null); /* TODO: send probe command */ }}
          onCancel={() => setPendingOp(null)}
        />
      )}
    </div>
  )
}

type ToolTab = 'tool' | 'facing' | 'console' | 'macros'
type WCSOrigin = 'center' | 'corner'
type StockCorner = 'x-y-' | 'x+y-' | 'x-y+' | 'x+y+'
type SurfaceDir = 'climb' | 'conventional' | 'both'

const CORNER_LABELS: Record<StockCorner, string> = {
  'x-y-': 'X− Y− (front-left)',
  'x+y-': 'X+ Y− (front-right)',
  'x-y+': 'X− Y+ (back-left)',
  'x+y+': 'X+ Y+ (back-right)',
}

interface MacroDef { id: string; name: string; code: string }
interface ToolEntry { number: number; description: string; diameter: string; tipZ: number | null }
type ConsoleEntry = { type: 'input' | 'output' | 'error'; text: string }

const DEFAULT_MACROS: MacroDef[] = [
  { id: '1', name: 'Home All',    code: '$H' },
  { id: '2', name: 'Safe Height', code: 'G90 G0 Z50' },
  { id: '3', name: 'Spindle On',  code: 'M3 S12000' },
  { id: '4', name: 'Spindle Off', code: 'M5' },
  { id: '5', name: 'Coolant On',  code: 'M8' },
  { id: '6', name: 'Coolant Off', code: 'M9' },
]

const DEFAULT_TOOLS: ToolEntry[] = [
  { number: 1, description: '6mm Flat End Mill', diameter: '6.0', tipZ: null },
  { number: 2, description: '3mm Ball End Mill', diameter: '3.0', tipZ: null },
  { number: 3, description: '8mm Rougher',       diameter: '8.0', tipZ: null },
]

const INIT_CONSOLE: ConsoleEntry[] = [
  { type: 'output', text: "Grbl 1.1h ['$' for help]" },
  { type: 'output', text: 'ok' },
]

function sfmt(n: number) { return n.toFixed(3) }

function generateSurfaceGCode(
  stockX: number, stockY: number, stepover: number, doc: number,
  feed: number, rpm: number, origin: WCSOrigin, corner: StockCorner, dir: SurfaceDir
): string {
  let xMin: number, xMax: number, yMin: number, yMax: number
  if (origin === 'center') {
    xMin = -(stockX / 2); xMax = stockX / 2
    yMin = -(stockY / 2); yMax = stockY / 2
  } else {
    xMin = corner.startsWith('x+') ? -stockX : 0
    xMax = corner.startsWith('x+') ? 0 : stockX
    yMin = corner.includes('y+') ? -stockY : 0
    yMax = corner.includes('y+') ? 0 : stockY
  }
  const pf = Math.round(feed * 0.3)
  const lines = [`G90 G21`, `S${rpm} M3`, `G4 P2`, `G0 Z5`]
  const ys: number[] = []
  for (let y = yMin; y < yMax - 0.001; y += stepover) ys.push(parseFloat(y.toFixed(3)))
  ys.push(parseFloat(yMax.toFixed(3)))
  if (dir === 'both') {
    lines.push(`G0 X${sfmt(xMin)} Y${sfmt(yMin)}`, `G1 Z${sfmt(-doc)} F${pf}`)
    let right = true
    ys.forEach((y, i) => {
      lines.push(`G1 X${sfmt(right ? xMax : xMin)} Y${sfmt(y)} F${feed}`)
      if (i < ys.length - 1) lines.push(`G1 Y${sfmt(ys[i + 1])} F${feed}`)
      right = !right
    })
  } else {
    const [sx, ex] = dir === 'climb' ? [xMin, xMax] : [xMax, xMin]
    ys.forEach((y, i) => {
      if (i > 0) lines.push(`G0 Z2`)
      lines.push(`G0 X${sfmt(sx)} Y${sfmt(y)}`, `G1 Z${sfmt(-doc)} F${pf}`, `G1 X${sfmt(ex)} F${feed}`)
    })
  }
  lines.push(`G0 Z5`, `M5`)
  return lines.join('\n')
}

function ToolchangeScreen({
  machineState, onConfirm, onStop, onPauseResume, onGcodeGenerated, onSwitchToProgram,
}: {
  machineState: MachineState
  onConfirm: (key: ModalKey) => void
  onStop: () => void
  onPauseResume: () => void
  onGcodeGenerated: (gcode: string, filename: string) => void
  onSwitchToProgram: () => void
}) {
  const [toolTab, setToolTab] = useState<ToolTab>('tool')
  const [tools, setTools] = useState<ToolEntry[]>(DEFAULT_TOOLS)
  const [activeTool, setActiveTool] = useState(1)
  const [colletRefZ, setColletRefZ] = useState<string>('')
  const [colletConfirmOpen, setColletConfirmOpen] = useState(false)
  const [addToolOpen, setAddToolOpen] = useState(false)
  const [newTool, setNewTool] = useState<{ number: string; description: string; diameter: string }>({ number: '', description: '', diameter: '' })
  const [stockX, setStockX] = useState('60')
  const [stockY, setStockY] = useState('40')
  const [stepover, setStepover] = useState('20')
  const [doc, setDoc] = useState('0.2')
  const [surfFeed, setSurfFeed] = useState('1000')
  const [surfRpm, setSurfRpm] = useState('12000')
  const [origin, setOrigin] = useState<WCSOrigin>('center')
  const [corner, setCorner] = useState<StockCorner>('x-y-')
  const [surfDir, setSurfDir] = useState<SurfaceDir>('both')
  const [surfaceGCode, setSurfaceGCode] = useState<string | null>(null)
  const [consoleLog, setConsoleLog] = useState<ConsoleEntry[]>(INIT_CONSOLE)
  const [consoleInput, setConsoleInput] = useState('')
  const consoleEndRef = useRef<HTMLDivElement>(null)
  const [macros, setMacros] = useState<MacroDef[]>(DEFAULT_MACROS)
  const [editMode, setEditMode] = useState(false)
  const [editingMacro, setEditingMacro] = useState<MacroDef | null>(null)
  const [macroDialogOpen, setMacroDialogOpen] = useState(false)

  useEffect(() => {
    consoleEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [consoleLog])

  const sendCommand = () => {
    const cmd = consoleInput.trim()
    if (!cmd) return
    setConsoleLog(prev => [...prev, { type: 'input', text: cmd }, { type: 'output', text: 'ok' }])
    setConsoleInput('')
  }

  const openNewMacro = () => { setEditingMacro({ id: Date.now().toString(), name: '', code: '' }); setMacroDialogOpen(true) }
  const openEditMacro = (m: MacroDef) => { setEditingMacro({ ...m }); setMacroDialogOpen(true) }
  const saveMacro = () => {
    if (!editingMacro) return
    setMacros(prev => prev.find(m => m.id === editingMacro.id)
      ? prev.map(m => m.id === editingMacro.id ? editingMacro : m)
      : [...prev, editingMacro])
    setMacroDialogOpen(false)
    setEditingMacro(null)
  }

  const handleGenerate = () => {
    const code = generateSurfaceGCode(
      parseFloat(stockX)||60, parseFloat(stockY)||40, parseFloat(stepover)||20,
      parseFloat(doc)||0.2, parseFloat(surfFeed)||1000, parseFloat(surfRpm)||12000,
      origin, corner, surfDir
    )
    setSurfaceGCode(code)
    onGcodeGenerated(code, 'facing.nc')
  }

  const TOOL_TABS: { id: ToolTab; label: string }[] = [
    { id: 'tool',    label: 'Tool' },
    { id: 'facing',  label: 'Facing' },
    { id: 'console', label: 'Console' },
    { id: 'macros',  label: 'Macros' },
  ]

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Sub-tabs */}
      <div className="border-b bg-card px-4 py-2 flex gap-1.5 shrink-0">
        {TOOL_TABS.map(({ id, label }) => (
          <button key={id} onClick={() => setToolTab(id)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${toolTab === id ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground'}`}
          >{label}</button>
        ))}
      </div>

      {/* ── Tool ── */}
      {toolTab === 'tool' && (
        <div className="flex-1 overflow-y-auto min-h-0 px-4 py-3 flex flex-col gap-4">

          {/* Collet nut reference */}
          <div className="flex flex-col gap-1.5">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide px-1">Collet Nut Reference</p>
            <div className="bg-muted rounded-xl px-4 py-3 flex flex-col gap-2.5">
              <p className="text-xs text-muted-foreground leading-relaxed">
                Lower the spindle nose (no tool) until it touches a flat reference surface. Saving this Z lets the app calculate stickout for every probed tool.
              </p>
              {colletRefZ ? (
                <div className="flex items-center gap-2">
                  <div className="flex-1 bg-background rounded-lg px-3 py-2 flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">Z</span>
                    <span className="text-sm font-mono font-semibold">{parseFloat(colletRefZ).toFixed(3)}</span>
                    <span className="text-xs text-muted-foreground">mm</span>
                  </div>
                  <button onClick={() => setColletConfirmOpen(true)} className="bg-background rounded-lg px-3 py-2 text-xs font-medium active:opacity-70 whitespace-nowrap">Re-measure</button>
                  <button onClick={() => setColletRefZ('')} className="bg-background rounded-lg px-3 py-2 text-xs font-medium text-red-500 active:opacity-70">Clear</button>
                </div>
              ) : (
                <button onClick={() => setColletConfirmOpen(true)} className="w-full bg-foreground text-background rounded-xl py-2.5 text-sm font-semibold active:opacity-80 transition-opacity">
                  Save Z as Collet Reference
                </button>
              )}
            </div>
          </div>

          {/* Active tool */}
          <div className="bg-muted rounded-xl px-4 py-3 flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Active Tool</p>
              <p className="text-sm font-semibold mt-0.5">
                T{activeTool} — {tools.find(t => t.number === activeTool)?.description ?? 'Unknown'}
              </p>
            </div>
            <button className="bg-background rounded-lg px-3 py-2 text-xs font-medium active:opacity-70 transition-opacity">
              Probe Length
            </button>
          </div>

          {/* Tool table */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between px-1">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Tool Table</p>
              <button onClick={() => { setNewTool({ number: String(Math.max(...tools.map(t => t.number), 0) + 1), description: '', diameter: '' }); setAddToolOpen(true) }}
                className="flex items-center gap-1 text-xs font-medium bg-muted rounded-full px-2.5 py-1 active:opacity-70">
                <Plus size={11} />Add Tool
              </button>
            </div>
            {tools.map(tool => {
              const colletNum = parseFloat(colletRefZ)
              const stickout = (!isNaN(colletNum) && tool.tipZ !== null)
                ? (colletNum - tool.tipZ).toFixed(2) + ' mm'
                : '—'
              return (
                <button key={tool.number} onClick={() => setActiveTool(tool.number)}
                  className={`flex items-center gap-3 rounded-xl px-4 py-3 text-left transition-colors ${activeTool === tool.number ? 'bg-foreground text-background' : 'bg-muted active:bg-muted-foreground/20'}`}
                >
                  <span className={`text-xs font-mono w-6 shrink-0 ${activeTool === tool.number ? 'text-background/60' : 'text-muted-foreground'}`}>T{tool.number}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{tool.description}</p>
                    <p className={`text-xs mt-0.5 ${activeTool === tool.number ? 'text-background/60' : 'text-muted-foreground'}`}>
                      ⌀{tool.diameter} mm · Stickout: {stickout}
                    </p>
                  </div>
                  {activeTool === tool.number && <span className="text-xs font-medium text-background/80 shrink-0">Active</span>}
                </button>
              )
            })}
          </div>

          <button className="w-full bg-muted rounded-xl py-3 text-sm font-semibold active:opacity-70 transition-opacity">
            Run Tool Change (M6 T{activeTool})
          </button>
        </div>
      )}

      {/* ── Facing ── */}
      {toolTab === 'facing' && (
        <div className="flex-1 overflow-y-auto min-h-0 px-4 py-3 flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide px-1">WCS Origin</p>
            <div className="flex gap-1.5">
              {(['center', 'corner'] as WCSOrigin[]).map(o => (
                <button key={o} onClick={() => setOrigin(o)}
                  className={`flex-1 py-2.5 rounded-xl text-sm font-medium transition-colors ${origin === o ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground'}`}
                >{o === 'center' ? 'Center of stock' : 'Corner of stock'}</button>
              ))}
            </div>
            {origin === 'corner' && (
              <div className="grid grid-cols-2 gap-1.5 pt-1">
                {(Object.entries(CORNER_LABELS) as [StockCorner, string][]).map(([key, label]) => (
                  <button key={key} onClick={() => setCorner(key)}
                    className={`py-2.5 rounded-xl text-xs font-medium transition-colors ${corner === key ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground'}`}
                  >{label}</button>
                ))}
              </div>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide px-1">Stock Dimensions</p>
            <div className="flex gap-3">
              <label className="flex-1 flex flex-col gap-1">
                <span className="text-xs text-muted-foreground px-1">X (mm)</span>
                <input type="number" value={stockX} onChange={e => setStockX(e.target.value)} className="bg-muted rounded-xl px-3 py-2.5 text-sm font-mono w-full" />
              </label>
              <label className="flex-1 flex flex-col gap-1">
                <span className="text-xs text-muted-foreground px-1">Y (mm)</span>
                <input type="number" value={stockY} onChange={e => setStockY(e.target.value)} className="bg-muted rounded-xl px-3 py-2.5 text-sm font-mono w-full" />
              </label>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide px-1">Cut Parameters</p>
            <div className="flex gap-3">
              <label className="flex-1 flex flex-col gap-1">
                <span className="text-xs text-muted-foreground px-1">Stepover (mm)</span>
                <input type="number" value={stepover} onChange={e => setStepover(e.target.value)} className="bg-muted rounded-xl px-3 py-2.5 text-sm font-mono w-full" />
              </label>
              <label className="flex-1 flex flex-col gap-1">
                <span className="text-xs text-muted-foreground px-1">DOC (mm)</span>
                <input type="number" value={doc} onChange={e => setDoc(e.target.value)} step="0.1" className="bg-muted rounded-xl px-3 py-2.5 text-sm font-mono w-full" />
              </label>
            </div>
            <div className="flex gap-3">
              <label className="flex-1 flex flex-col gap-1">
                <span className="text-xs text-muted-foreground px-1">Feedrate (mm/min)</span>
                <input type="number" value={surfFeed} onChange={e => setSurfFeed(e.target.value)} className="bg-muted rounded-xl px-3 py-2.5 text-sm font-mono w-full" />
              </label>
              <label className="flex-1 flex flex-col gap-1">
                <span className="text-xs text-muted-foreground px-1">RPM</span>
                <input type="number" value={surfRpm} onChange={e => setSurfRpm(e.target.value)} className="bg-muted rounded-xl px-3 py-2.5 text-sm font-mono w-full" />
              </label>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide px-1">Direction</p>
            <div className="flex gap-1.5">
              {([{ id: 'climb', label: 'Climb' }, { id: 'conventional', label: 'Conventional' }, { id: 'both', label: 'Both Ways' }] as { id: SurfaceDir; label: string }[]).map(({ id, label }) => (
                <button key={id} onClick={() => setSurfDir(id)}
                  className={`flex-1 py-2.5 rounded-xl text-xs font-medium transition-colors ${surfDir === id ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground'}`}
                >{label}</button>
              ))}
            </div>
          </div>

          {surfaceGCode && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between px-1">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Generated G-code</p>
                <button onClick={onSwitchToProgram} className="text-xs text-blue-500 font-medium active:opacity-70">
                  View in Program →
                </button>
              </div>
              <pre className="bg-muted rounded-xl px-4 py-3 text-xs font-mono text-muted-foreground overflow-x-auto whitespace-pre">{surfaceGCode}</pre>
              <button className="w-full bg-foreground text-background rounded-xl py-3 text-sm font-semibold active:opacity-80 transition-opacity">
                Run Facing Cycle
              </button>
            </div>
          )}

          <button onClick={handleGenerate} className="w-full bg-muted rounded-xl py-3 text-sm font-semibold active:opacity-70 transition-opacity">
            {surfaceGCode ? 'Regenerate' : 'Generate G-code'}
          </button>
        </div>
      )}

      {/* ── Console ── */}
      {toolTab === 'console' && (
        <div className="flex-1 flex flex-col min-h-0">
          <div className="flex-1 overflow-y-auto min-h-0 bg-zinc-950 px-4 py-3 flex flex-col gap-1">
            {consoleLog.map((entry, i) => (
              <p key={i} className={`text-xs font-mono leading-relaxed ${entry.type === 'input' ? 'text-zinc-200' : entry.type === 'error' ? 'text-red-400' : 'text-zinc-500'}`}>
                {entry.type === 'input' ? '> ' : ''}{entry.text}
              </p>
            ))}
            <div ref={consoleEndRef} />
          </div>
          <div className="border-t bg-card px-3 py-2 flex gap-2 shrink-0">
            <input
              type="text" value={consoleInput}
              onChange={e => setConsoleInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && sendCommand()}
              placeholder="Enter G-code command…"
              className="flex-1 bg-muted rounded-lg px-3 py-2 text-sm font-mono min-w-0"
            />
            <button onClick={sendCommand}
              className="bg-foreground text-background rounded-lg px-3 py-2 text-sm font-medium active:opacity-70 transition-opacity flex items-center gap-1.5 shrink-0"
            >
              <Send size={14} />
            </button>
          </div>
        </div>
      )}

      {/* ── Macros ── */}
      {toolTab === 'macros' && (
        <div className="flex-1 flex flex-col min-h-0">
          <div className="flex items-center justify-between px-4 py-2 border-b shrink-0">
            <p className="text-xs text-muted-foreground">{macros.length} macros</p>
            <div className="flex gap-2">
              <button onClick={() => setEditMode(v => !v)}
                className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${editMode ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground'}`}
              >Edit</button>
              <button onClick={openNewMacro}
                className="bg-muted rounded-full px-3 py-1.5 text-xs font-medium flex items-center gap-1 active:opacity-70"
              ><Plus size={12} />Add</button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto min-h-0 px-4 py-3">
            <div className="grid grid-cols-2 gap-2">
              {macros.map(macro => (
                <div key={macro.id} className="relative">
                  <button className="w-full bg-muted rounded-xl px-3 py-3 text-left active:bg-muted-foreground/20 transition-colors">
                    <p className="text-sm font-semibold truncate pr-8">{macro.name}</p>
                    <p className="text-[10px] font-mono text-muted-foreground mt-0.5 truncate">{macro.code}</p>
                  </button>
                  {editMode && (
                    <div className="absolute top-1.5 right-1.5 flex gap-1">
                      <button onClick={() => openEditMacro(macro)} className="bg-background rounded-lg p-1.5 active:opacity-70"><Pencil size={11} /></button>
                      <button onClick={() => setMacros(prev => prev.filter(m => m.id !== macro.id))} className="bg-background rounded-lg p-1.5 active:opacity-70 text-red-500"><Trash2 size={11} /></button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <MachineActions machineState={machineState} onConfirm={onConfirm} onStop={onStop} onPauseResume={onPauseResume} />

      {/* Collet reference confirmation */}
      <Dialog open={colletConfirmOpen} onOpenChange={setColletConfirmOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Save Collet Reference</DialogTitle></DialogHeader>
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground leading-relaxed">
              Saves the current MCS Z as the collet nut reference. Make sure the spindle nose is touching the reference surface.
            </p>
            <div className="bg-muted rounded-xl px-4 py-3">
              <p className="text-xs font-mono text-muted-foreground">FluidNC will pause at M0 and wait for confirmation. Press <span className="font-semibold text-foreground">⌥N</span> to cancel.</p>
            </div>
            <div className="flex gap-2">
              <button onClick={() => setColletConfirmOpen(false)} className="flex-1 bg-muted rounded-lg py-2.5 text-sm font-medium">Cancel</button>
              <button onClick={() => {
                setColletRefZ(colletRefZ || '-48.500')
                setColletConfirmOpen(false)
              }} className="flex-1 bg-foreground text-background rounded-lg py-2.5 text-sm font-medium">Confirm</button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Add Tool dialog */}
      <Dialog open={addToolOpen} onOpenChange={setAddToolOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Add Tool</DialogTitle></DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex gap-3">
              <label className="flex flex-col gap-1 w-20 shrink-0">
                <span className="text-xs text-muted-foreground">T#</span>
                <input type="number" value={newTool.number} onChange={e => setNewTool(p => ({ ...p, number: e.target.value }))} className="bg-muted rounded-lg px-3 py-2 text-sm font-mono w-full" />
              </label>
              <label className="flex-1 flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">Diameter (mm)</span>
                <input type="number" value={newTool.diameter} onChange={e => setNewTool(p => ({ ...p, diameter: e.target.value }))} step="0.1" className="bg-muted rounded-lg px-3 py-2 text-sm font-mono w-full" />
              </label>
            </div>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Description</span>
              <input type="text" value={newTool.description} onChange={e => setNewTool(p => ({ ...p, description: e.target.value }))} placeholder="e.g. 6mm Flat End Mill" className="bg-muted rounded-lg px-3 py-2 text-sm" />
            </label>
            <div className="flex gap-2">
              <button onClick={() => setAddToolOpen(false)} className="flex-1 bg-muted rounded-lg py-2.5 text-sm font-medium">Cancel</button>
              <button onClick={() => {
                const num = parseInt(newTool.number)
                if (!num || !newTool.description) return
                setTools(prev => [...prev.filter(t => t.number !== num), { number: num, description: newTool.description, diameter: newTool.diameter || '—', tipZ: null }].sort((a, b) => a.number - b.number))
                setAddToolOpen(false)
              }} className="flex-1 bg-foreground text-background rounded-lg py-2.5 text-sm font-medium">Add</button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={macroDialogOpen} onOpenChange={setMacroDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{editingMacro?.name ? `Edit: ${editingMacro.name}` : 'New Macro'}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Name</span>
              <input type="text" value={editingMacro?.name ?? ''} onChange={e => setEditingMacro(prev => prev ? { ...prev, name: e.target.value } : prev)} className="bg-muted rounded-lg px-3 py-2 text-sm" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">G-code</span>
              <textarea value={editingMacro?.code ?? ''} onChange={e => setEditingMacro(prev => prev ? { ...prev, code: e.target.value } : prev)} rows={5} className="bg-muted rounded-lg px-3 py-2 text-sm font-mono resize-none" />
            </label>
            <div className="flex gap-2">
              <button onClick={() => setMacroDialogOpen(false)} className="flex-1 bg-muted rounded-lg py-2.5 text-sm font-medium">Cancel</button>
              <button onClick={saveMacro} className="flex-1 bg-foreground text-background rounded-lg py-2.5 text-sm font-medium">Save</button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Desktop layout
// ─────────────────────────────────────────────────────────────────────────────

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [query])
  return matches
}

type RightTab = 'console' | 'macros' | 'probe' | 'camera'

function DesktopLayout({
  gcode, gcodeFilename, onGcodeChange,
  machineState, onConfirm, onStop, onPauseResume,
}: {
  gcode: string | null
  gcodeFilename: string | null
  onGcodeChange: (g: string | null, f: string | null) => void
  machineState: MachineState
  onConfirm: (key: ModalKey) => void
  onStop: () => void
  onPauseResume: () => void
}) {
  const [rightTab, setRightTab] = useState<RightTab>('console')

  // ── Backend connection ───────────────────────────────────────────────────────
  const [backendHost, setBackendHost] = useState(window.location.host || 'raspberrypi.local:8080')
  const [backendUrl, setBackendUrl] = useState<string | null>(null)
  const [connectOpen, setConnectOpen] = useState(false)

  const { wsOpen, status, metrics: piMetrics, wsConsole, send } = useBackend(backendUrl)

  const connected = wsOpen
  const firmware  = status.firmware
  const detecting = wsOpen && !status.firmware

  const handleConnect = () => {
    if (connected) {
      setBackendUrl(null)
      setConnectOpen(false)
    } else {
      setBackendUrl(`${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${backendHost}`)
      setConnectOpen(false)
    }
  }

  // ── Jog state (lifted so keyboard jog can access feedrate/jogAmount) ─────────
  const [feedrate, setFeedrate]     = useState(500)
  const [jogAmount, setJogAmount]   = useState(1)

  const handleJog = useCallback((axis: string, dist: number, feed: number) => {
    send({ type: 'jog', data: { axis, dist, feed } })
  }, [send])

  // ── Keyboard jog ─────────────────────────────────────────────────────────────
  const [kbdActive, setKbdActive] = useState(false)
  const kbdActiveRef = useRef(false)
  kbdActiveRef.current = kbdActive
  // Keep feedrate/jogAmount accessible inside the key handler without stale closure
  const feedrateRef  = useRef(feedrate)
  const jogAmountRef = useRef(jogAmount)
  feedrateRef.current  = feedrate
  jogAmountRef.current = jogAmount

  useEffect(() => {
    const KEY_AXIS: Record<string, [string, 1 | -1]> = {
      w: ['Y',  1], s: ['Y', -1],
      a: ['X', -1], d: ['X',  1],
      q: ['Z',  1], e: ['Z', -1],
    }
    const onDown = (ev: KeyboardEvent) => {
      if (!kbdActiveRef.current) return
      if (ev.repeat) return
      if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLTextAreaElement) return
      const mapping = KEY_AXIS[ev.key.toLowerCase()]
      if (!mapping) return
      ev.preventDefault()
      const [axis, sign] = mapping
      send({ type: 'jog', data: { axis, dist: sign * jogAmountRef.current, feed: feedrateRef.current } })
    }
    window.addEventListener('keydown', onDown)
    return () => window.removeEventListener('keydown', onDown)
  }, [send])

  // ── Overrides (display from backend, send on click) ──────────────────────────
  const feedOverride    = status.feedOverride
  const spindleOverride = status.spindleOverride

  const clampOverride = (v: number) => Math.min(200, Math.max(10, Math.round(v)))

  const adjustFeed = (delta: number) =>
    send({ type: 'feedOverride', data: { value: clampOverride(feedOverride + delta) } })

  const adjustSpindle = (delta: number) =>
    send({ type: 'spindleOverride', data: { value: clampOverride(spindleOverride + delta) } })

  // ── WCS offsets (local editable table; zero sends to machine) ────────────────
  const [wcsOffsets, setWcsOffsets] = useState<Record<WCSOption, [string,string,string]>>({
    G54: ['0.000','0.000','0.000'], G55: ['0.000','0.000','0.000'],
    G56: ['0.000','0.000','0.000'], G57: ['0.000','0.000','0.000'],
    G58: ['0.000','0.000','0.000'], G59: ['0.000','0.000','0.000'],
  })

  const updateWcsOffset = (wcs: WCSOption, axis: 0|1|2, val: string) =>
    setWcsOffsets(prev => ({ ...prev, [wcs]: prev[wcs].map((v,i) => i===axis ? val : v) as [string,string,string] }))

  const handleDROZero = (wcs: WCSOption, axis: 'X' | 'Y' | 'Z') => {
    const idx = { X: 0, Y: 1, Z: 2 }[axis] as 0|1|2
    updateWcsOffset(wcs, idx, '0.000')
    send({ type: 'zero', data: { axis: axis.toLowerCase() as 'x' | 'y' | 'z', wcs } })
  }

  // ── Alarm / job derived from backend state ───────────────────────────────────
  const alarm      = status.state === 'Alarm' ? `ALARM — machine is in alarm state` : null
  const jobProgress = status.job.percent

  // ── WCS table open state ─────────────────────────────────────────────────────
  const [wcsOpen, setWcsOpen] = useState(true)

  // ── Timelapse / camera ───────────────────────────────────────────────────────
  const [tlState, setTlState] = useState<TimelapseState>('idle')
  const [tlFps, setTlFps] = useState(1)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [timelapses, setTimelapses] = useState<TimelapseEntry[]>(MOCK_TIMELAPSES)
  const [stats, setStats] = useState<GCodeStats | null>(null)

  // ── Console ──────────────────────────────────────────────────────────────────
  const [consoleInput, setConsoleInput] = useState('')
  const consoleEndRef = useRef<HTMLDivElement>(null)
  useEffect(() => { consoleEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [wsConsole])

  const sendCommand = () => {
    const cmd = consoleInput.trim(); if (!cmd) return
    send({ type: 'command', data: { cmd } })
    setConsoleInput('')
  }

  // ── Macros ───────────────────────────────────────────────────────────────────
  const [macros, setMacros] = useState<MacroDef[]>(DEFAULT_MACROS)
  const [editMode, setEditMode] = useState(false)
  const [editingMacro, setEditingMacro] = useState<MacroDef | null>(null)
  const [macroDialogOpen, setMacroDialogOpen] = useState(false)
  const [pendingProbe, setPendingProbe] = useState<ProbeOp | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const openNewMacro = () => { setEditingMacro({ id: Date.now().toString(), name: '', code: '' }); setMacroDialogOpen(true) }
  const openEditMacro = (m: MacroDef) => { setEditingMacro({ ...m }); setMacroDialogOpen(true) }
  const saveMacro = () => {
    if (!editingMacro) return
    setMacros(prev => prev.find(m => m.id === editingMacro.id)
      ? prev.map(m => m.id === editingMacro.id ? editingMacro : m)
      : [...prev, editingMacro])
    setMacroDialogOpen(false); setEditingMacro(null)
  }

  const formatTime = (s: number) => { if (!s) return '—'; const m = Math.floor(s/60), sec = Math.round(s%60); return m > 0 ? `${m}m ${sec}s` : `${sec}s` }

  return (
    <div className="h-dvh flex flex-col bg-background text-foreground">
      {/* Top bar */}
      <header className="h-11 border-b bg-card flex items-center px-5 gap-4 shrink-0 relative">
        <span className="text-sm font-semibold tracking-tight">CNC Controller</span>
        <div className="w-px h-4 bg-border" />
        {/* Serial connection */}
        <div className="relative">
          <button onClick={() => setConnectOpen(v => !v)}
            className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg bg-muted hover:bg-muted/80 transition-colors">
            {connected ? <PlugZap size={13} className="text-green-500" /> : <Plug size={13} className="text-muted-foreground" />}
            <span className={connected ? 'text-green-600 font-mono' : 'text-muted-foreground'}>{connected ? backendHost : 'Not connected'}</span>
            <ChevronDown size={11} className={`text-muted-foreground transition-transform ${connectOpen ? 'rotate-180' : ''}`} />
          </button>
          {connectOpen && (
            <div className="absolute top-full left-0 mt-1 w-72 bg-card border rounded-xl shadow-lg p-3 z-50 flex flex-col gap-2">
              <label className="flex flex-col gap-1">
                <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Backend Host</span>
                <input type="text" value={backendHost} onChange={e => setBackendHost(e.target.value)}
                  className="bg-muted rounded-lg px-3 py-2 text-sm font-mono" placeholder="raspberrypi.local:8080" />
              </label>
              <p className="text-[10px] text-muted-foreground px-1">
                WebSocket: <span className="font-mono">ws://{backendHost}</span>
              </p>
              <button onClick={handleConnect}
                className={`w-full rounded-lg py-2 text-sm font-semibold transition-colors ${connected ? 'bg-muted text-red-500' : 'bg-foreground text-background'}`}>
                {connected ? 'Disconnect' : 'Connect'}
              </button>
              {firmware && (
                <div className={`rounded-lg px-3 py-2 flex items-center gap-2 ${firmware.type === 'grbl' ? 'bg-indigo-50 dark:bg-indigo-950' : 'bg-orange-50 dark:bg-orange-950'}`}>
                  <span className={`text-xs font-bold font-mono ${firmware.type === 'grbl' ? 'text-indigo-600' : 'text-orange-600'}`}>
                    {firmware.type === 'grbl' ? 'GRBL' : 'FluidNC'}
                  </span>
                  <span className={`text-xs font-mono ${firmware.type === 'grbl' ? 'text-indigo-500' : 'text-orange-500'}`}>{firmware.version}</span>
                  {firmware.board && <span className="text-[10px] text-muted-foreground ml-auto">{firmware.board}</span>}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Firmware badge */}
        {detecting && (
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" />
            <span className="animate-pulse">Detecting…</span>
          </div>
        )}
        {firmware && !detecting && (
          <div className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-mono font-semibold ${
            firmware.type === 'grbl'
              ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300'
              : 'bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300'
          }`}>
            <span>{firmware.type === 'grbl' ? 'GRBL' : 'FluidNC'}</span>
            <span className="opacity-60">{firmware.version}</span>
            {firmware.board && <span className="opacity-40">[{firmware.board}]</span>}
          </div>
        )}

        <div className="ml-auto flex items-center gap-5">
          {/* Pi system metrics */}
          {piMetrics && (() => {
            const cpuColor  = piMetrics.cpu  > 80 ? 'text-red-500'    : piMetrics.cpu  > 50 ? 'text-orange-500' : 'text-green-600'
            const tempColor = piMetrics.temp > 75 ? 'text-red-500'    : piMetrics.temp > 62 ? 'text-orange-500' : 'text-green-600'
            const ramPct    = piMetrics.ramUsed / piMetrics.ramTotal * 100
            const ramColor  = ramPct > 80 ? 'text-red-500' : ramPct > 60 ? 'text-orange-500' : 'text-green-600'
            return (
              <div className="flex items-center gap-3 text-[10px] font-mono border-r pr-5">
                <div className="flex flex-col items-center gap-0.5">
                  <span className="text-muted-foreground/60 uppercase tracking-wide text-[9px]">CPU</span>
                  <span className={`font-semibold ${cpuColor}`}>{piMetrics.cpu}%</span>
                </div>
                <div className="flex flex-col items-center gap-0.5">
                  <span className="text-muted-foreground/60 uppercase tracking-wide text-[9px]">Temp</span>
                  <span className={`font-semibold ${tempColor}`}>{piMetrics.temp}°</span>
                </div>
                <div className="flex flex-col items-center gap-0.5">
                  <span className="text-muted-foreground/60 uppercase tracking-wide text-[9px]">RAM</span>
                  <span className={`font-semibold ${ramColor}`}>{piMetrics.ramUsed}<span className="font-normal text-muted-foreground"> MB</span></span>
                </div>
                <div className="flex flex-col items-center gap-0.5">
                  <span className="text-muted-foreground/60 uppercase tracking-wide text-[9px]">Load</span>
                  <span className="font-semibold text-muted-foreground">{piMetrics.load1.toFixed(2)}</span>
                </div>
              </div>
            )
          })()}
          <div className="flex items-center gap-5 text-xs font-mono text-muted-foreground">
            <span>Feed: {feedOverride}%</span>
            <span>Speed: {spindleOverride}%</span>
            <span>T1</span>
          </div>
        </div>
      </header>

      {/* Three-column body */}
      <div className="flex-1 flex overflow-hidden min-h-0">

        {/* ── Left: DRO + Jog + Camera ── */}
        <div className="w-80 border-r flex flex-col overflow-hidden shrink-0">
          <div className="flex-1 overflow-y-auto min-h-0">
            <DRO onZero={handleDROZero} wpos={status.wpos} mpos={status.mpos} />
            <JogInterface
              onConfirm={onConfirm}
              onJog={handleJog}
              feedrate={feedrate}
              jogAmount={jogAmount}
              onFeedrateChange={setFeedrate}
              onJogAmountChange={setJogAmount}
            />

            {/* Feed / Speed override strip */}
            <div className="px-4 py-3 border-t flex flex-col gap-2">
              {[
                { label: 'Feed',  value: feedOverride,    adjust: adjustFeed,    reset: () => send({ type: 'feedOverride',    data: { value: 100 } }) },
                { label: 'Speed', value: spindleOverride, adjust: adjustSpindle, reset: () => send({ type: 'spindleOverride', data: { value: 100 } }) },
              ].map(({ label, value, adjust, reset }) => (
                <div key={label} className="flex items-center gap-1.5">
                  <span className="text-xs text-muted-foreground w-9 shrink-0">{label}</span>
                  {[-10,-5].map(d => (
                    <button key={d} onClick={() => adjust(d)}
                      className="px-1.5 py-1 rounded-lg bg-muted text-xs font-mono text-muted-foreground hover:bg-muted/80 active:opacity-70 transition-colors">
                      {d}%
                    </button>
                  ))}
                  <span className="text-sm font-semibold font-mono w-11 text-center">{value}%</span>
                  {[5,10].map(d => (
                    <button key={d} onClick={() => adjust(d)}
                      className="px-1.5 py-1 rounded-lg bg-muted text-xs font-mono text-muted-foreground hover:bg-muted/80 active:opacity-70 transition-colors">
                      +{d}%
                    </button>
                  ))}
                  <button onClick={reset} className="text-[10px] text-muted-foreground hover:text-foreground px-1 transition-colors">↺</button>
                </div>
              ))}
            </div>

            {/* Keyboard jog toggle */}
            <div className="border-t px-4 py-2.5">
              <div className="relative group/kbd inline-block">
                <button
                  onClick={() => { setKbdActive(v => !v); if (kbdActive) setActiveKeys(new Set()) }}
                  className={`flex items-center gap-2 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors ${kbdActive ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground hover:text-foreground'}`}
                >
                  <Keyboard size={13} />
                  <span>Keyboard Jog</span>
                </button>
                {/* Hover tooltip */}
                <div className="pointer-events-none absolute left-0 bottom-full mb-2 bg-popover border rounded-xl shadow-lg p-3 hidden group-hover/kbd:block z-50 min-w-max">
                  <div className="flex flex-col items-center gap-1.5">
                    <div className="flex flex-col items-center gap-0.5">
                      <kbd className="w-7 h-6 rounded text-[10px] font-mono flex items-center justify-center border bg-muted border-border text-muted-foreground">W</kbd>
                      <div className="flex gap-0.5">
                        {(['A','S','D']).map(k => <kbd key={k} className="w-7 h-6 rounded text-[10px] font-mono flex items-center justify-center border bg-muted border-border text-muted-foreground">{k}</kbd>)}
                      </div>
                    </div>
                    <span className="text-[10px] text-muted-foreground">XY  ·  Q/E = Z</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

        </div>

        {/* ── Center: Visualizer ── */}
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
          <div className="border-b px-4 py-2 flex items-center gap-3 shrink-0 bg-card">
            <button onClick={() => fileRef.current?.click()}
              className="flex items-center gap-2 bg-muted rounded-lg px-3 py-1.5 text-xs font-medium active:opacity-70 shrink-0">
              <FolderOpen size={14} />Load
            </button>
            <span className="text-xs text-muted-foreground truncate min-w-0">{gcodeFilename ?? 'No file loaded'}</span>
            <input ref={fileRef} type="file" accept=".nc,.gcode,.g,.tap" className="hidden"
              onChange={e => {
                const file = e.target.files?.[0]; if (!file) return
                const reader = new FileReader()
                reader.onload = ev => onGcodeChange(ev.target?.result as string, file.name)
                reader.readAsText(file)
              }}
            />
          </div>
          <div className="flex-1 bg-[#fafafa] min-h-0">
            <GCodeVisualizer gcode={gcode} onStats={setStats} toolPosition={status.mpos} />
          </div>
          {gcode && stats && (
            <div className="border-t px-5 py-2 flex gap-6 shrink-0 bg-card">
              {[
                { label: 'Lines',  value: stats.lineCount?.toLocaleString() ?? '—' },
                { label: 'Time',   value: formatTime(stats.estimatedTime) },
                { label: 'Rapids', value: stats.rapidCount?.toLocaleString() ?? '—' },
                { label: 'Cuts',   value: stats.cutCount?.toLocaleString() ?? '—' },
                { label: 'X',      value: stats.bounds ? `${(stats.bounds.max.x - stats.bounds.min.x).toFixed(1)} mm` : '—' },
                { label: 'Y',      value: stats.bounds ? `${(stats.bounds.max.y - stats.bounds.min.y).toFixed(1)} mm` : '—' },
                { label: 'Z',      value: stats.bounds ? `${(stats.bounds.max.z - stats.bounds.min.z).toFixed(1)} mm` : '—' },
                { label: 'Z min',  value: stats.bounds ? `${stats.bounds.min.z.toFixed(1)} mm` : '—' },
              ].map(({ label, value }) => (
                <div key={label} className="flex flex-col gap-0.5">
                  <span className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</span>
                  <span className="text-xs font-semibold font-mono">{value}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Right: Console / Macros / Probe / Camera ── */}
        <div className="w-72 border-l flex flex-col overflow-hidden shrink-0">
          <div className="flex shrink-0 bg-card border-b">
            {(['console', 'macros', 'probe', 'camera'] as RightTab[]).map(t => (
              <button key={t} onClick={() => setRightTab(t)}
                className={`flex-1 py-2.5 text-[11px] font-medium capitalize transition-colors border-b-2 -mb-px ${rightTab === t ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
              >{t}</button>
            ))}
          </div>

          {/* Console */}
          {rightTab === 'console' && (
            <div className="flex-1 flex flex-col min-h-0">
              <div className="flex-1 overflow-y-auto bg-zinc-950 px-3 py-2 flex flex-col gap-0.5 min-h-0">
                {wsConsole.map((entry, i) => (
                  <p key={i} className={`text-xs font-mono leading-relaxed ${entry.dir === 'tx' ? 'text-zinc-200' : entry.line.startsWith('ERROR') ? 'text-red-400' : 'text-zinc-500'}`}>
                    {entry.dir === 'tx' ? '> ' : ''}{entry.line}
                  </p>
                ))}
                {wsConsole.length === 0 && (
                  <p className="text-xs font-mono text-zinc-600 italic">
                    {connected ? 'Waiting for machine…' : 'Not connected'}
                  </p>
                )}
                <div ref={consoleEndRef} />
              </div>
              <div className="border-t px-2 py-2 flex gap-2 bg-card shrink-0">
                <input type="text" value={consoleInput}
                  onChange={e => setConsoleInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && sendCommand()}
                  placeholder="G-code command…"
                  className="flex-1 bg-muted rounded-lg px-2.5 py-1.5 text-xs font-mono min-w-0"
                  disabled={!connected}
                />
                <button onClick={sendCommand} disabled={!connected}
                  className="bg-foreground text-background rounded-lg px-2.5 py-1.5 shrink-0 active:opacity-70 flex items-center disabled:opacity-40">
                  <Send size={13} />
                </button>
              </div>
            </div>
          )}

          {/* Macros */}
          {rightTab === 'macros' && (
            <div className="flex-1 flex flex-col min-h-0">
              <div className="flex items-center justify-between px-3 py-2 border-b shrink-0">
                <span className="text-xs text-muted-foreground">{macros.length} macros</span>
                <div className="flex gap-1.5">
                  <button onClick={() => setEditMode(v => !v)}
                    className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${editMode ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground'}`}
                  >Edit</button>
                  <button onClick={openNewMacro} className="bg-muted rounded-full px-2.5 py-1 text-xs font-medium flex items-center gap-1 active:opacity-70">
                    <Plus size={11} />Add
                  </button>
                </div>
              </div>
              <div className="flex-1 overflow-y-auto min-h-0 p-3">
                <div className="grid grid-cols-2 gap-1.5">
                  {macros.map(macro => (
                    <div key={macro.id} className="relative">
                      <button className="w-full bg-muted rounded-xl px-3 py-2.5 text-left active:bg-muted-foreground/20">
                        <p className="text-xs font-semibold truncate pr-6">{macro.name}</p>
                        <p className="text-[10px] font-mono text-muted-foreground mt-0.5 truncate">{macro.code}</p>
                      </button>
                      {editMode && (
                        <div className="absolute top-1 right-1 flex gap-0.5">
                          <button onClick={() => openEditMacro(macro)} className="bg-background rounded p-1 active:opacity-70"><Pencil size={10} /></button>
                          <button onClick={() => setMacros(prev => prev.filter(m => m.id !== macro.id))} className="bg-background rounded p-1 active:opacity-70 text-red-500"><Trash2 size={10} /></button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Probe */}
          {rightTab === 'probe' && (
            <div className="flex-1 overflow-y-auto min-h-0 px-3 py-2 flex flex-col gap-3">
              {PROBE_GROUPS.map(group => (
                <div key={group} className="flex flex-col gap-1">
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wide px-1">{group}</p>
                  {(Object.entries(PROBE_OPS) as [ProbeOp, ProbeOpDef][])
                    .filter(([, def]) => def.group === group)
                    .map(([key, def]) => (
                      <button key={key} onClick={() => setPendingProbe(key)}
                        className="flex items-center gap-2 bg-muted rounded-xl px-3 py-2 text-left active:bg-muted-foreground/20 transition-colors">
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-semibold">{def.title}</p>
                          <p className="text-[10px] text-muted-foreground truncate">{def.desc}</p>
                        </div>
                        <span className="text-muted-foreground text-sm shrink-0">›</span>
                      </button>
                    ))}
                </div>
              ))}
            </div>
          )}

          {/* Camera tab */}
          {rightTab === 'camera' && (
            <div className="flex-1 flex flex-col min-h-0 overflow-y-auto">
              <div className="w-full bg-muted" style={{ aspectRatio: '4/3' }}>
                <div className="w-full h-full flex flex-col items-center justify-center gap-2 relative">
                  <Camera size={22} className="text-muted-foreground/40" />
                  <span className="text-xs text-muted-foreground">No camera feed</span>
                  {tlState === 'recording' && (
                    <div className="absolute top-2 right-2 flex items-center gap-1.5 bg-black/50 rounded-full px-2 py-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
                      <span className="text-[10px] text-white font-medium">REC</span>
                    </div>
                  )}
                  {tlState === 'paused' && (
                    <div className="absolute top-2 right-2 bg-black/50 rounded-full px-2 py-1">
                      <span className="text-[10px] text-white font-medium">PAUSED</span>
                    </div>
                  )}
                </div>
              </div>
              {/* Controls row: record/pause/stop + fps selector + folder */}
              <div className="px-3 py-2 flex items-center gap-2 border-b">
                {tlState === 'idle' && (
                  <button onClick={() => setTlState('recording')}
                    className="flex items-center gap-1 bg-red-500 text-white rounded-lg px-2.5 py-1.5 text-xs font-semibold active:opacity-80 shrink-0">
                    <Circle size={11} className="fill-white" />Rec
                  </button>
                )}
                {tlState === 'recording' && (<>
                  <button onClick={() => setTlState('paused')}
                    className="flex items-center gap-1 bg-muted rounded-lg px-2.5 py-1.5 text-xs font-semibold active:opacity-80 shrink-0">
                    <Pause size={11} />Pause
                  </button>
                  <button onClick={() => setTlState('idle')}
                    className="flex items-center gap-1 bg-muted rounded-lg px-2.5 py-1.5 text-xs font-semibold text-red-500 active:opacity-80 shrink-0">
                    <Square size={11} />Stop
                  </button>
                </>)}
                {tlState === 'paused' && (<>
                  <button onClick={() => setTlState('recording')}
                    className="flex items-center gap-1 bg-muted rounded-lg px-2.5 py-1.5 text-xs font-semibold text-green-500 active:opacity-80 shrink-0">
                    <Play size={11} />Resume
                  </button>
                  <button onClick={() => setTlState('idle')}
                    className="flex items-center gap-1 bg-muted rounded-lg px-2.5 py-1.5 text-xs font-semibold text-red-500 active:opacity-80 shrink-0">
                    <Square size={11} />Stop
                  </button>
                </>)}
                <div className="flex gap-1 ml-auto">
                  {TIMELAPSE_FPS.map(f => (
                    <button key={f} onClick={() => setTlFps(f)}
                      className={`px-2 py-1 rounded-lg text-xs font-medium transition-colors ${tlFps === f ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground'}`}
                    >{f}</button>
                  ))}
                </div>
                <button onClick={() => setLibraryOpen(true)} className="bg-muted rounded-lg p-1.5 active:opacity-80 shrink-0">
                  <Folder size={14} />
                </button>
              </div>
              {/* Timelapse library list */}
              <div className="flex-1 overflow-y-auto px-3 py-2 flex flex-col gap-1.5">
                {timelapses.length === 0
                  ? <p className="text-xs text-muted-foreground text-center py-6">No timelapses yet</p>
                  : timelapses.map(tl => (
                    <div key={tl.id} className="flex items-center gap-2 bg-muted rounded-lg px-3 py-2">
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium truncate">{tl.name}</p>
                        <p className="text-[10px] text-muted-foreground">{tl.date} · {tl.duration} · {tl.size}</p>
                      </div>
                      <button className="p-1 rounded hover:bg-background transition-colors"><Play size={12} /></button>
                      <button className="p-1 rounded hover:bg-background transition-colors"><Download size={12} /></button>
                      <button onClick={() => setTimelapses(prev => prev.filter(t => t.id !== tl.id))} className="p-1 rounded hover:bg-background transition-colors text-red-500"><Trash2 size={12} /></button>
                    </div>
                  ))
                }
              </div>
            </div>
          )}

          {/* WCS offset table — collapsible */}
          <div className="border-t shrink-0">
            <button
              onClick={() => setWcsOpen(v => !v)}
              className="w-full flex items-center gap-2 px-3 py-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
            >
              WCS Offsets
              <ChevronDown size={12} className={`ml-auto transition-transform duration-200 ${wcsOpen ? 'rotate-180' : ''}`} />
            </button>
            {wcsOpen && (
              <div className="px-3 pb-2">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-[10px] text-muted-foreground">
                      <th className="text-left font-medium pb-1 w-9"></th>
                      {['X','Y','Z'].map(a => <th key={a} className="text-right font-medium pb-1">{a}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {(WCS_OPTIONS as readonly WCSOption[]).map(wcs => (
                      <tr key={wcs}>
                        <td className="text-muted-foreground font-mono pr-2 py-0.5">{wcs}</td>
                        {([0,1,2] as const).map(axis => (
                          <td key={axis} className="py-0.5">
                            <input
                              type="number"
                              value={wcsOffsets[wcs][axis]}
                              onChange={e => updateWcsOffset(wcs, axis, e.target.value)}
                              step="0.001"
                              className="w-full text-right bg-transparent font-mono focus:bg-muted rounded px-1 outline-none text-xs"
                            />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {/* G-code filename */}
            {gcodeFilename && (
              <div className="border-t px-3 py-1.5 flex items-center gap-1.5">
                <FileCode2 size={11} className="text-muted-foreground shrink-0" />
                <span className="text-[10px] text-muted-foreground font-mono truncate">{gcodeFilename}</span>
              </div>
            )}
          </div>

          {/* Alarm / status banner */}
          <div className={`border-t shrink-0 px-3 py-2 flex items-center gap-2 ${alarm ? 'bg-red-50 dark:bg-red-950' : ''}`}>
            {alarm ? (
              <>
                <AlertTriangle size={13} className="text-red-500 shrink-0" />
                <span className="text-xs font-medium text-red-600 flex-1 min-w-0 truncate">{alarm}</span>
                <button onClick={() => send({ type: 'unlock' })} className="shrink-0 text-xs text-red-400 hover:text-red-600 font-medium transition-colors">Unlock</button>
              </>
            ) : (
              <>
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${status.state === 'Run' ? 'bg-green-500 animate-pulse' : status.state === 'Hold' ? 'bg-orange-400' : 'bg-muted-foreground/40'}`} />
                <span className="text-xs text-muted-foreground">{status.state ?? (connected ? 'Connecting…' : 'Disconnected')}</span>
                <span className="ml-auto text-[10px] font-mono text-muted-foreground/60">{status.feed > 0 ? `F${status.feed}` : ''}</span>
              </>
            )}
          </div>
          {/* Job progress bar */}
          <div className="border-t shrink-0">
            <div className="h-1 bg-muted">
              <div className="h-full bg-blue-500 transition-all duration-300" style={{ width: `${jobProgress}%` }} />
            </div>
            <div className="flex items-center justify-between px-3 py-1">
              <span className="text-[10px] text-muted-foreground">
                {status.job.state === 'idle' ? 'No job'
                 : status.job.state === 'complete' ? 'Complete'
                 : status.job.state === 'error' ? 'Error'
                 : `${Math.round(jobProgress)}%`}
              </span>
              {status.job.filename && (
                <span className="text-[10px] font-mono text-muted-foreground/60 truncate max-w-28">{status.job.filename}</span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Machine actions bar */}
      <MachineActions
        machineState={machineState}
        onConfirm={onConfirm}
        onStop={() => { onStop(); send({ type: 'cancel' }) }}
        onPauseResume={() => {
          if (machineState === 'paused') { onPauseResume(); send({ type: 'resume' }) }
          else { onPauseResume(); send({ type: 'pause' }) }
        }}
        onHome={() => send({ type: 'home' })}
        onReset={() => send({ type: 'reset' })}
        onUnlock={() => send({ type: 'unlock' })}
      />

      {pendingProbe && (
        <ConfirmModal open
          title={`Run: ${PROBE_OPS[pendingProbe].title}`}
          description={PROBE_OPS[pendingProbe].confirmDesc}
          confirmLabel="Run Probe Cycle"
          onConfirm={() => setPendingProbe(null)}
          onCancel={() => setPendingProbe(null)}
        />
      )}

      <Dialog open={macroDialogOpen} onOpenChange={setMacroDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>{editingMacro?.name ? `Edit: ${editingMacro.name}` : 'New Macro'}</DialogTitle></DialogHeader>
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Name</span>
              <input type="text" value={editingMacro?.name ?? ''} onChange={e => setEditingMacro(prev => prev ? { ...prev, name: e.target.value } : prev)} className="bg-muted rounded-lg px-3 py-2 text-sm" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">G-code</span>
              <textarea value={editingMacro?.code ?? ''} onChange={e => setEditingMacro(prev => prev ? { ...prev, code: e.target.value } : prev)} rows={4} className="bg-muted rounded-lg px-3 py-2 text-sm font-mono resize-none" />
            </label>
            <div className="flex gap-2">
              <button onClick={() => setMacroDialogOpen(false)} className="flex-1 bg-muted rounded-lg py-2.5 text-sm font-medium">Cancel</button>
              <button onClick={saveMacro} className="flex-1 bg-foreground text-background rounded-lg py-2.5 text-sm font-medium">Save</button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default function App() {
  const isDesktop = useMediaQuery('(min-width: 1024px)')
  const [active, setActive] = useState<Tab>('control')
  const [modal, setModal] = useState<ModalKey>(null)
  const [machineState, setMachineState] = useState<MachineState>('idle')
  const [gcode, setGcode] = useState<string | null>(null)
  const [gcodeFilename, setGcodeFilename] = useState<string | null>(null)

  const handleGcodeChange = (g: string | null, f: string | null) => { setGcode(g); setGcodeFilename(f) }

  const openModal = (key: ModalKey) => setModal(key)
  const closeModal = () => setModal(null)

  const handleStop = () => {
    setMachineState('paused')
    // TODO: send pause command to machine
    setModal('stop')
  }

  const handlePauseResume = () => {
    if (machineState === 'paused') {
      setMachineState('running')
      // TODO: send resume command to machine
    } else {
      setMachineState('paused')
      // TODO: send pause command to machine
    }
  }

  const handleConfirm = () => {
    if (modal === 'stop') {
      setMachineState('idle')
      // TODO: send stop command to machine
    } else if (modal === 'run') {
      setMachineState('running')
      // TODO: send run command to machine
    }
    closeModal()
  }

  const handleCancel = () => {
    if (modal === 'stop') {
      // machine stays paused — user chose "Pause"
    }
    closeModal()
  }

  if (isDesktop) {
    return (
      <>
        <DesktopLayout
          gcode={gcode}
          gcodeFilename={gcodeFilename}
          onGcodeChange={handleGcodeChange}
          machineState={machineState}
          onConfirm={openModal}
          onStop={handleStop}
          onPauseResume={handlePauseResume}
        />
        {modal && (
          <ConfirmModal open {...MODALS[modal]} onConfirm={handleConfirm} onCancel={handleCancel} />
        )}
      </>
    )
  }

  return (
    <div className="h-dvh flex flex-col bg-background text-foreground overflow-hidden">
      <div className="flex-1 flex flex-col overflow-hidden min-h-0">
        {active === 'control' && (
          <ControlScreen
            machineState={machineState}
            onConfirm={openModal}
            onStop={handleStop}
            onPauseResume={handlePauseResume}
          />
        )}
        {active === 'camera' && (
          <CameraScreen
            machineState={machineState}
            onConfirm={openModal}
            onStop={handleStop}
            onPauseResume={handlePauseResume}
          />
        )}
        {active === 'program' && (
          <ProgramScreen
            machineState={machineState}
            onConfirm={openModal}
            onStop={handleStop}
            onPauseResume={handlePauseResume}
            gcode={gcode}
            filename={gcodeFilename}
            onGcodeChange={handleGcodeChange}
          />
        )}
        {active === 'probe' && (
          <ProbeScreen
            machineState={machineState}
            onConfirm={openModal}
            onStop={handleStop}
            onPauseResume={handlePauseResume}
          />
        )}
        {active === 'toolchange' && (
          <ToolchangeScreen
            machineState={machineState}
            onConfirm={openModal}
            onStop={handleStop}
            onPauseResume={handlePauseResume}
            onGcodeGenerated={handleGcodeChange}
            onSwitchToProgram={() => setActive('program')}
          />
        )}
      </div>

      <nav className="border-t bg-background flex">
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setActive(id)}
            className={`flex-1 min-w-0 flex flex-col items-center gap-1 py-3 text-xs transition-colors ${
              active === id ? 'text-foreground' : 'text-muted-foreground'
            }`}
          >
            <Icon size={22} strokeWidth={active === id ? 2 : 1.5} />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      {modal && (
        <ConfirmModal
          open
          {...MODALS[modal]}
          onConfirm={handleConfirm}
          onCancel={handleCancel}
        />
      )}
    </div>
  )
}
