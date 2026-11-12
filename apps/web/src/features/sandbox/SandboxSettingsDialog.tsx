import { type SandboxImage, type SandboxSettings, DEFAULT_SANDBOX_SETTINGS } from '@harness/shared'
import { CheckCircle2Icon, FolderOpenIcon, HammerIcon, KeyRoundIcon, LoaderIcon, PlusIcon, ShieldCheckIcon, TriangleAlertIcon, XIcon } from 'lucide-react'
import { useState } from 'react'
import {
  useBuildSandbox,
  usePickFolder,
  useProjects,
  useSandboxBuild,
  useSandboxStatus,
  useSetProjectSandbox,
  useSetSandboxCertificates,
  useSetSandboxToken,
} from '@/api/queries'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

/** What a project's own Dockerfile starts from. */
const CUSTOM_DOCKERFILE_START = `FROM harness-sandbox
# Add the tools your research needs, e.g.:
# RUN apt-get update && apt-get install -y --no-install-recommends texlive-latex-extra latexmk && rm -rf /var/lib/apt/lists/*
`

/** The variables Bedrock needs (the quick-add button). */
const BEDROCK_VARIABLES = ['CLAUDE_CODE_USE_BEDROCK', 'AWS_REGION', 'AWS_PROFILE']

const section = 'grid gap-2 rounded-lg border p-3'
const sectionTitle = 'text-sm font-semibold'
const hint = 'text-xs text-muted-foreground'

/**
 * How a project's sandboxed nodes run: Docker's state on this machine, the Claude login token
 * (shared by all projects), the image (Harness's own, a Dockerfile of the project's, or an
 * existing image), credentials and extra folders the sandbox may see, and whether new threads
 * start sandboxed.
 */
export function SandboxSettingsDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const project = useProjects().data?.find((p) => p.id === projectId)
  const status = useSandboxStatus().data
  const save = useSetProjectSandbox(projectId)
  const [draft, setDraft] = useState<SandboxSettings | null>(null)
  const settings = draft ?? project?.sandbox ?? DEFAULT_SANDBOX_SETTINGS
  const change = (patch: Partial<SandboxSettings>) => setDraft({ ...settings, ...patch })
  const [envText, setEnvText] = useState<string | null>(null)
  const envShown = envText ?? settings.env.join('\n')
  const envNames = (text: string) => [...new Set(text.split(/[\s,]+/).map((v) => v.trim()).filter(Boolean))]

  const submit = () => {
    const next = { ...settings, env: envNames(envShown) }
    save.mutate(next, { onSuccess: onClose })
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Sandbox settings{project ? ` · ${project.name}` : ''}</DialogTitle>
          <DialogDescription>
            A sandboxed node's replies run Claude Code in a Docker container. It sees the project folder read-only and
            the node's own copy (the only place it can change files), plus what you add here, and nothing else of this
            machine. It reaches the internet only through Harness's proxy, which refuses this machine (Harness, Docker, anything on localhost) and your local network.
          </DialogDescription>
        </DialogHeader>

        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <DockerState />
          <LoginToken />
          <Certificates />
          <ImageSection
            projectId={projectId}
            image={settings.image}
            defaultDockerfile={status?.defaultDockerfile ?? ''}
            cliVersion={status?.cliVersion ?? null}
            dirty={draft !== null && JSON.stringify(draft.image) !== JSON.stringify(project?.sandbox.image)}
            onChange={(image) => change({ image })}
          />

          <div className={section}>
            <div className={sectionTitle}>Credentials and folders</div>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 size-4 accent-[var(--status-secure)]"
                checked={settings.shareAws}
                onChange={(e) => change({ shareAws: e.target.checked })}
              />
              <span>
                Share <code className="font-mono text-xs">~/.aws</code> (read-only), for Bedrock.
                <span className={cn(hint, 'block')}>The model in the sandbox can read whatever credentials you share.</span>
              </span>
            </label>
            <div className="grid gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="sandbox-env">Environment variables to pass (names, one per line)</Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => setEnvText(envNames(`${envShown}\n${BEDROCK_VARIABLES.join('\n')}`).join('\n'))}
                >
                  <PlusIcon /> Bedrock
                </Button>
              </div>
              <Textarea
                id="sandbox-env"
                rows={3}
                className="font-mono text-xs"
                placeholder={'e.g.\nCLAUDE_CODE_USE_BEDROCK\nAWS_REGION'}
                value={envShown}
                onChange={(e) => setEnvText(e.target.value)}
              />
              <p className={hint}>
                Their values come from Harness's own environment when a sandbox starts; they are never stored.
              </p>
            </div>
            <ExtraFolders mounts={settings.mounts} onChange={(mounts) => change({ mounts })} />
          </div>

          <label className="flex items-start gap-2 rounded-lg border p-3 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-4 accent-[var(--status-secure)]"
              checked={settings.newNodes}
              onChange={(e) => change({ newNodes: e.target.checked })}
            />
            <span>
              New threads in this project start sandboxed
              <span className={cn(hint, 'block')}>Branches and merges take their parents' setting either way.</span>
            </span>
          </label>

          {save.isError && <p className="text-sm text-destructive">{save.error.message}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={save.isPending || !project}>{save.isPending ? 'Saving…' : 'Save'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Whether Docker runs here, and what to do if not. */
function DockerState() {
  const status = useSandboxStatus()
  const docker = status.data?.docker
  if (!docker) return <p className={hint}>Checking Docker…</p>
  const ready = docker.state === 'ready'
  return (
    <div className={cn('flex items-start gap-2 rounded-lg border px-3 py-2 text-sm', ready ? 'border-secure/40 bg-secure-soft/50' : 'border-destructive/40 bg-destructive/5')}>
      {ready ? <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-secure" /> : <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />}
      <div>
        {ready ? `Docker ${docker.version} is running.` : docker.message}
        {status.data?.cliVersion && <span className={cn(hint, 'block')}>Claude Code on this machine: {status.data.cliVersion} (Harness's image gets the same version).</span>}
      </div>
    </div>
  )
}

/** The login token every sandbox uses (one for all projects). */
function LoginToken() {
  const status = useSandboxStatus().data
  const setToken = useSetSandboxToken()
  const [value, setValue] = useState('')
  const [editing, setEditing] = useState(false)
  const source = status?.token ?? null

  return (
    <div className={section}>
      <div className={cn(sectionTitle, 'flex items-center gap-1.5')}><KeyRoundIcon className="size-4" /> Claude login</div>
      <p className={hint}>
        The sandbox can't use the login of Claude Code on this machine. Run <code className="font-mono">claude setup-token</code> in
        a terminal (it opens your browser and prints a long-lived token for your subscription) and paste the token here.
        It is kept in Harness's data folder, for all projects. The model in the sandbox can read it. Using Bedrock or
        Vertex instead? Pass their variables below; no token needed.
      </p>
      {source && !editing ? (
        <div className="flex items-center gap-2 text-sm">
          <CheckCircle2Icon className="size-4 text-secure" />
          {source === 'saved' ? 'A token is saved.' : 'Using CLAUDE_CODE_OAUTH_TOKEN from Harness\'s environment.'}
          <Button type="button" variant="outline" size="xs" onClick={() => setEditing(true)}>Replace</Button>
          {source === 'saved' && (
            <Button type="button" variant="ghost" size="xs" disabled={setToken.isPending} onClick={() => setToken.mutate(null)}>Remove</Button>
          )}
        </div>
      ) : (
        <div className="flex gap-2">
          <Input
            type="password"
            autoComplete="off"
            placeholder="sk-ant-oat01-…"
            aria-label="Claude login token"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <Button
            type="button"
            disabled={value.trim().length < 10 || setToken.isPending}
            onClick={() => setToken.mutate(value.trim(), { onSuccess: () => { setValue(''); setEditing(false) } })}
          >
            Save token
          </Button>
          {editing && <Button type="button" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>}
        </div>
      )}
      {setToken.isError && <p className="text-xs text-destructive">{setToken.error.message}</p>}
    </div>
  )
}

/**
 * This machine's extra certificates (a VPN or company network that inspects HTTPS installs one)
 * and proxy settings, which the image takes over. For all projects; a change rebuilds the image.
 */
function Certificates() {
  const status = useSandboxStatus().data
  const save = useSetSandboxCertificates()
  const [open, setOpen] = useState(false)
  if (!status) return null
  const certs = status.certificates
  const excluded = certs.filter((c) => !c.included).map((c) => c.fingerprint)
  const included = certs.length - excluded.length
  const setIncluded = (fingerprints: string[], on: boolean) =>
    save.mutate(on ? excluded.filter((f) => !fingerprints.includes(f)) : [...new Set([...excluded, ...fingerprints])])

  return (
    <div className={section}>
      <div className={cn(sectionTitle, 'flex items-center gap-1.5')}><ShieldCheckIcon className="size-4" /> Certificates and proxy</div>
      <p className={hint}>
        On a VPN or company network that inspects HTTPS (Cloudflare WARP, Zscaler, …), connections only work with the
        network's own root certificate. The sandbox image trusts the certificates this machine trusts beyond the public
        ones; they hold no secrets. For all projects; changing them rebuilds the image.
      </p>
      {certs.length === 0 ? (
        <p className="text-sm">This machine trusts no certificates beyond the public ones.</p>
      ) : (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>{included} of {certs.length} {certs.length === 1 ? 'certificate' : 'certificates'} from this machine go into the image.</span>
          <button type="button" className="text-xs text-muted-foreground underline" onClick={() => setOpen((v) => !v)}>
            {open ? 'Hide the list' : 'Show the list'}
          </button>
        </div>
      )}
      {open && certs.length > 0 && (
        <div className="grid gap-1">
          <div className="flex gap-3 text-xs">
            <button type="button" className="underline" disabled={save.isPending} onClick={() => setIncluded(certs.map((c) => c.fingerprint), true)}>Include all</button>
            <button type="button" className="underline" disabled={save.isPending} onClick={() => setIncluded(certs.map((c) => c.fingerprint), false)}>Include none</button>
          </div>
          <ul className="max-h-48 overflow-y-auto rounded border">
            {certs.map((c) => (
              <li key={c.fingerprint} className="border-b last:border-b-0">
                <label className="flex items-start gap-2 px-2 py-1.5 text-xs" title={`SHA-256 ${c.fingerprint}`}>
                  <input
                    type="checkbox"
                    className="mt-0.5 size-3.5 accent-[var(--status-secure)]"
                    checked={c.included}
                    disabled={save.isPending}
                    onChange={(e) => setIncluded([c.fingerprint], e.target.checked)}
                  />
                  <span className="min-w-0">
                    <span className="font-medium">{c.name}</span>
                    <span className="block text-muted-foreground">
                      {c.issuer === c.name ? 'Root certificate' : `Issued by ${c.issuer}`} · valid until {new Date(c.validTo).toLocaleDateString()}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className={hint}>
        {status.proxy.length > 0
          ? <>Your proxy is used for image builds, and the sandbox's own proxy goes through it: <code className="font-mono">{status.proxy.join(', ')}</code>.</>
          : "No proxy is set for Harness (HTTPS_PROXY and the like); set one in its environment and image builds and the sandbox's proxy go through it."}
      </p>
      {save.isError && <p className="text-xs text-destructive">{save.error.message}</p>}
    </div>
  )
}

/** Which image the sandbox runs, and building it. */
function ImageSection({ projectId, image, defaultDockerfile, cliVersion, dirty, onChange }: {
  projectId: string
  image: SandboxImage
  defaultDockerfile: string
  cliVersion: string | null
  /** The image setting changed and isn't saved yet (Build uses the saved one). */
  dirty: boolean
  onChange: (image: SandboxImage) => void
}) {
  const build = useBuildSandbox(projectId)
  const [showLog, setShowLog] = useState(false)
  const state = useSandboxBuild(projectId, true).data
  const building = state?.state === 'building'
  const [showDefault, setShowDefault] = useState(false)
  const radio = (kind: SandboxImage['kind'], label: string, help: string) => (
    <label className="flex items-start gap-2 text-sm">
      <input
        type="radio"
        name="sandbox-image"
        className="mt-0.5 size-4 accent-[var(--status-secure)]"
        checked={image.kind === kind}
        onChange={() => onChange(
          kind === 'default' ? { kind } : kind === 'dockerfile' ? { kind, dockerfile: CUSTOM_DOCKERFILE_START } : { kind, name: '' },
        )}
      />
      <span>
        {label}
        <span className={cn(hint, 'block')}>{help}</span>
      </span>
    </label>
  )

  return (
    <div className={section}>
      <div className={sectionTitle}>Image</div>
      {radio('default', "Harness's image", `Ubuntu 24.04 with git, Python and Claude Code${cliVersion ? ` ${cliVersion}` : ''}. Built the first time a sandbox starts.`)}
      {image.kind === 'default' && defaultDockerfile && (
        <button type="button" className="ml-6 w-fit text-xs text-muted-foreground underline" onClick={() => setShowDefault((v) => !v)}>
          {showDefault ? 'Hide its Dockerfile' : 'Show its Dockerfile'}
        </button>
      )}
      {image.kind === 'default' && showDefault && (
        <pre className="ml-6 max-h-48 overflow-auto rounded bg-muted p-2 font-mono text-[11px]">{defaultDockerfile}</pre>
      )}
      {radio('dockerfile', 'A Dockerfile of this project', 'Start from harness-sandbox (Harness\'s image) and add the tools you need. No build context: use RUN, not COPY.')}
      {image.kind === 'dockerfile' && (
        <Textarea
          aria-label="Dockerfile"
          rows={6}
          spellCheck={false}
          className="ml-6 w-[calc(100%-1.5rem)] font-mono text-xs"
          value={image.dockerfile}
          onChange={(e) => onChange({ kind: 'dockerfile', dockerfile: e.target.value })}
        />
      )}
      {radio('image', 'An existing image', 'Any image you built or pulled. It must have claude (the same version as here) and python3.')}
      {image.kind === 'image' && (
        <Input
          aria-label="Image name"
          className="ml-6 w-[calc(100%-1.5rem)] font-mono text-xs"
          placeholder="e.g. my-research-image:latest"
          value={image.name}
          onChange={(e) => onChange({ kind: 'image', name: e.target.value })}
        />
      )}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button type="button" variant="outline" size="sm" disabled={building || dirty || build.isPending} onClick={() => build.mutate()}>
          {building ? <LoaderIcon className="animate-spin" /> : <HammerIcon />}
          {building ? 'Building…' : 'Build now'}
        </Button>
        {dirty && <span className={hint}>Save first to build the new image.</span>}
        {!dirty && state?.state === 'ready' && <span className="text-xs text-secure">Ready: <code className="font-mono">{state.image}</code></span>}
        {!dirty && state?.state === 'failed' && <span className="text-xs text-destructive">{state.error}</span>}
        {state?.log && (
          <button type="button" className="text-xs text-muted-foreground underline" onClick={() => setShowLog((v) => !v)}>
            {showLog ? 'Hide build output' : 'Show build output'}
          </button>
        )}
      </div>
      {showLog && state?.log && (
        <pre className="max-h-56 overflow-auto rounded bg-muted p-2 font-mono text-[11px] whitespace-pre-wrap">{state.log}</pre>
      )}
    </div>
  )
}

/** Folders of this machine the sandbox also sees (read-only unless ticked). */
function ExtraFolders({ mounts, onChange }: { mounts: SandboxSettings['mounts']; onChange: (mounts: SandboxSettings['mounts']) => void }) {
  const pick = usePickFolder()
  return (
    <div className="grid gap-1.5">
      <Label>Extra folders</Label>
      {mounts.length === 0 && <p className={hint}>None: the sandbox sees only the project folder.</p>}
      {mounts.map((m, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            aria-label={`Folder ${i + 1}`}
            className="font-mono text-xs"
            value={m.path}
            onChange={(e) => onChange(mounts.map((x, j) => (j === i ? { ...x, path: e.target.value } : x)))}
          />
          <label className="flex shrink-0 items-center gap-1 text-xs">
            <input
              type="checkbox"
              className="size-3.5 accent-[var(--status-exposed)]"
              checked={m.writable}
              onChange={(e) => onChange(mounts.map((x, j) => (j === i ? { ...x, writable: e.target.checked } : x)))}
            />
            writable
          </label>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Remove folder" onClick={() => onChange(mounts.filter((_, j) => j !== i))}>
            <XIcon />
          </Button>
        </div>
      ))}
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pick.isPending}
          onClick={() => pick.mutate(undefined, { onSuccess: ({ path }) => path && onChange([...mounts, { path, writable: false }]) })}
        >
          <FolderOpenIcon /> {pick.isPending ? 'Choosing…' : 'Add folder…'}
        </Button>
      </div>
      {pick.isError && <p className="text-xs text-destructive">{pick.error.message}</p>}
    </div>
  )
}
