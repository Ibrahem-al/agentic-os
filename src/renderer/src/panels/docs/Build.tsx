/** Docs → Build & ship (ported from the engineering handbook). */
import { Callout, Code, CodeBlock, DocHeader, DocProse, H2, H3, Li, P, SpecTable, Strong, Ul } from '../../ui/docs'

export function Build(): React.JSX.Element {
  return (
    <div>
      <DocHeader
        kicker="engineering"
        title="Build & ship"
        intro="The build has to solve one hard problem well: native modules that must load under both plain Node (for tests) and Electron (for the app), on three operating systems. The native-rebuild step owns that, electron-builder never touches it, and a before-pack assertion refuses to ship a crashing app."
      />

      <DocProse>
        <H2>The commands</H2>
        <CodeBlock
          label="package.json scripts"
          code={`npm run dev              # electron-vite dev server with HMR
npm run build            # bundle into out/{main,preload,renderer}
npm run rebuild:native   # the dual-ABI + win32 RyuGraph rebuild
npm run package          # electron-builder --publish never → dist/
npm test                 # vitest, offline, scripted models
npm run test:e2e         # playwright against the production build`}
        />

        <H2>Why the native rebuild exists</H2>
        <H3>Dual-ABI better-sqlite3</H3>
        <P>
          better-sqlite3 is not N-API, so one binary cannot serve both plain Node (vitest, scripts)
          and Electron. The rebuild produces both and leaves the plain-Node ABI as the default, with
          the Electron ABI stashed alongside. At runtime, the storage layer picks the right one via
          better-sqlite3&apos;s <Code>nativeBinding</Code> option, catching ABI-mismatch errors and
          caching the winner.
        </P>
        <H3>The win32 RyuGraph Electron-safe build</H3>
        <P>
          The npm-shipped Windows prebuilt binds imports to <Code>node.exe</Code> with no delay-load
          hook, so requiring it inside <Code>electron.exe</Code> is an uncatchable native crash. On
          Windows the rebuild does an MSVC source build against Electron&apos;s headers, injects a{' '}
          <Code>/DELAYLOAD:node.exe</Code> link option, replaces the binding, and stamps a{' '}
          <Code>.electron-safe</Code> marker.
        </P>
        <Callout tone="warn" title="Re-run after every install">
          ryugraph&apos;s install script silently restores the crashing prebuilt on any later{' '}
          <Code>npm install</Code>, leaving the marker stale. Both the rebuild and before-pack
          byte-compare the binding against the prebuilt and refuse to trust a stale marker. A warm
          rebuild is seconds.
        </Callout>

        <H2>Packaging for Windows and Mac</H2>
        <SpecTable
          head={['platform', 'targets', 'notes']}
          rows={[
            ['Windows', 'NSIS .exe', 'oneClick per-user install, no elevation prompt'],
            ['macOS', 'dmg + zip, arm64 + x64', 'unsigned (identity null); zip feeds the updater feed'],
            ['Linux', 'AppImage + deb', 'developer-tools category']
          ]}
        />
        <P>
          The config sets <Code>npmRebuild: false</Code>, so electron-builder never rebuilds natives;
          the rebuild step owns them. Native modules and WASM loaders are <Strong>asar-unpacked</Strong> so
          absolute-path and dlopen loading keeps working. RyuGraph extensions and the session-end hook
          scripts ship as <Strong>extraResources</Strong> because native code and an external shell
          load them by absolute path, which cannot point inside an asar archive. A{' '}
          <Code>beforePack</Code> hook asserts every rebuild artifact and platform extension slice is
          present, failing early instead of shipping a crashing app.
        </P>

        <H2>Updates never risk your memory</H2>
        <P>
          Auto-update runs in the background against the GitHub releases feed. An installed update
          runs storage migrations behind a pre-migration backup on first boot; the graph store refuses
          to open a store newer than the build, and <Code>appdata.db</Code> is snapshotted before any
          schema change.
        </P>

        <H2>CI and the release gate</H2>
        <Ul>
          <Li><Strong>test</Strong> runs on a 3-OS matrix: lint, typecheck, vitest, an offline storage check with networking disabled, a 10k-node retrieval perf gate, and an Electron-ABI check.</Li>
          <Li><Strong>e2e</Strong> drives the real production build through Playwright: an 8-step golden path that ingests a codebase, serves context, learns from a session, approves a staged write, undoes a file write, and adopts an improved skill.</Li>
          <Li><Strong>package</Strong> runs only on version tags, caching the ~30-60 minute Windows RyuGraph build, and uploads per-OS installers.</Li>
        </Ul>
        <P>
          Tests default to offline against scripted models. Live paths are opt-in behind{' '}
          <Code>OLLAMA=1</Code>, <Code>RERANKER=1</Code>, and <Code>PERF=1</Code>.
        </P>
      </DocProse>
    </div>
  )
}
