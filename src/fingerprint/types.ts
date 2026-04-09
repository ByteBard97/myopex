export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

export interface ElementProps {
  role: string
  name: string
  bounds: Bounds
  visible: boolean
  backgroundColor: string
  color: string
  fontSize: string
  borderWidth: string
  opacity: string
  display: string
  overflow: string
  textOverflow: boolean
  textContent: string
  childCount: number
  screenshotFile?: string | null
}

export interface Component {
  /** Composite key: regionKey/role["name"] or regionKey/role[index] */
  id: string
  props: ElementProps
  children?: Component[]
}

export interface Region {
  role: string
  bounds: Bounds
  background: string
  childCount: number
  /** Optional natural language summary — populated by --summarize (v2.1) */
  summary?: string
  /** Approximate token count for this region's YAML — Math.ceil(chars / 4) */
  _estimated_tokens?: number
  components: Component[]
}

export interface PageMeta {
  url: string
  title: string
  viewport: { width: number; height: number }
  theme: string
  background: string
  layout: string
  landmarks: string[]
  capturedAt: string
}

export interface FingerprintState {
  name: string
  modals: string
  selection: string | null
}

export interface UIFingerprint {
  version: number
  page: PageMeta
  regions: Record<string, Region>
  ungrouped: Component[]
  state: FingerprintState
}

export interface DiffFailure {
  component: string
  region: string
  property: string
  expected: string | number | boolean
  actual: string | number | boolean
  screenshotFile?: string | null
}

export interface DiffReport {
  pass: boolean
  timestamp: string
  old: string
  new: string
  totalChecked: number
  passed: number
  failed: number
  missing: string[]
  added: string[]
  failures: DiffFailure[]
}
