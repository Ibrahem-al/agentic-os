; build/installer.nsh — auto-included by electron-builder (NsisTarget resolves
; getResource(nsis.include, "installer.nsh") from the buildResources dir `build/`).
; Included in BOTH the installer pass and the BUILD_UNINSTALLER pass, so the
; uninstaller-only Var below is guarded and the un* macros are only INSERTED by
; uninstaller.nsh (never in the installer pass).
;
; ─────────────────────────────────────────────────────────────────────────────
; DATA-SAFE INSTALL / UPDATE / UNINSTALL LIFECYCLE  (see docs/DATA-MIGRATION.md)
;
; The app ships a oneClick per-user installer (electron-builder.yml →
; nsis.oneClick:true, perMachine:false). electron-updater applies auto-updates
; by running this installer SILENTLY (/S). The absolute invariant: a SILENT run
; must ALWAYS keep data (update in place); a wipe may ONLY be offered on an
; INTERACTIVE double-click, and even then it is recorded as intent and performed
; — backed up first — by the APP, never by the installer.
;
; SAFETY INVARIANTS ENCODED IN THIS FILE
;   * Every MessageBox carries an /SD default; the silent default of every
;     dialog is the SAFE (keep-data / update) answer.
;   * The installer NEVER deletes or moves user data. The destructive branch
;     only writes an intent marker (reset-data-requested.json); the app resets
;     on next boot AFTER a verified backup (src/main/storage/reset.ts).
;   * The uninstaller's "remove data" is a Rename (MOVE) into
;     %APPDATA%\agentic-os-backups\<stamp> — there is NO `RMDir /r "$APPDATA`
;     anywhere in our code, and `--delete-app-data` is never used.
;   * deleteAppDataOnUninstall stays UNSET, so the template's own app-data
;     RMDir block (uninstaller.nsh:216-248) is dead code; customUnInstall owns
;     the choice.
;
; The two literals shared with src/main/config.ts (RESET_MARKER_FILENAME and
; UNINSTALL_BACKUP_DIRNAME) are enforced by tests/unit/installer.invariants.test.ts.
; ─────────────────────────────────────────────────────────────────────────────


; ── Installer: 3-way already-installed choice ────────────────────────────────
; WHY preInit: installer.nsi inserts `preInit` at the very top of .onInit
; (installer.nsi:55-57), BEFORE electron-builder's own auto-uninstall
; (installUtil.nsh, included at installer.nsi:91). So "Cancel" here Quits before
; anything is touched. WHY HKCU + ${UNINSTALL_REGISTRY_KEY}: the per-user
; installer writes its uninstall entry there (multiUser.nsh); reading its
; UninstallString is the canonical "is it installed?" probe.
;
; SILENT semantics: a /S run auto-answers the ONLY dialog it meets (the 3-way)
; with /SD IDYES = Update-keep-data; the destructive branch additionally sits
; behind a second dialog whose /SD default is IDNO — so a silent run structurally
; cannot reach the marker write. Core NSIS only (no LogicLib) in this macro.
!macro preInit
  ReadRegStr $0 HKCU "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
  StrCmp $0 "" agentic_os_install_proceed 0
    MessageBox MB_YESNOCANCEL|MB_ICONQUESTION "agentic-os is already installed on this computer.$\r$\n$\r$\nYES  -  Update (recommended): your memory graph and all data are KEPT.$\r$\nNO  -  Reinstall from scratch: your data is first COPIED to a backup, then the app starts fresh.$\r$\nCANCEL  -  do nothing." /SD IDYES IDYES agentic_os_install_proceed IDNO agentic_os_reset_confirm
    ; Fallthrough = CANCEL -> leave the existing install untouched.
    Quit
  agentic_os_reset_confirm:
    ; Second, explicit confirm for the destructive choice. /SD IDNO: a silent
    ; run (which cannot reach here) would DECLINE the reset. Declining falls
    ; back to the SAFE update path (the user still chose to install).
    MessageBox MB_YESNO|MB_ICONEXCLAMATION "On the next launch the app will FIRST copy your memory graph, databases and settings into %APPDATA%\${APP_FILENAME}\backups\<timestamp>-pre-reset\ and only then start fresh.$\r$\n$\r$\nNothing is deleted without that backup.$\r$\n$\r$\nContinue with reinstall-from-scratch?" /SD IDNO IDYES agentic_os_write_marker IDNO agentic_os_install_proceed
  agentic_os_write_marker:
    ; RECORD INTENT ONLY — the installer never deletes data. The app performs
    ; the recoverable, backed-up, integrity-checked reset on its next boot and
    ; then removes this marker (src/main/storage/reset.ts). If the intent cannot
    ; even be recorded, fall back to keep-data (never proceed destructively).
    ClearErrors
    CreateDirectory "$APPDATA\${APP_FILENAME}"
    FileOpen $1 "$APPDATA\${APP_FILENAME}\reset-data-requested.json" w
    IfErrors agentic_os_install_proceed 0
    FileWrite $1 '{"source":"installer","installerVersion":"${VERSION}"}'
    FileClose $1
  agentic_os_install_proceed:
!macroend


; ── Uninstaller: keep-vs-remove data (interactive only) ──────────────────────
; The uninstaller-only flag. !ifdef BUILD_UNINSTALLER so it is declared solely
; in the uninstaller pass (this file is included in both passes).
!ifdef BUILD_UNINSTALLER
  Var agenticRemoveData
!endif

; customUnInit is inserted at uninstaller.nsh:33-35, AFTER un.onInit's one-click
; "$(areYouSureToUninstall)" prompt which SetSilent's the run — so ${Silent} is
; TRUE even for an INTERACTIVE one-click uninstall (uninstaller.nsh:18-29).
; Detect a genuine interactive run by parsing the RAW command line for /S,
; NOT ${Silent}. electron-updater's update flow runs the OLD uninstaller with
; `/S /KEEP_APP_DATA --updated` (installUtil.nsh:202-224), so BOTH /S and
; ${isUpdated} route to keep-data.
!macro customUnInit
  StrCpy $agenticRemoveData "0"
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/S" $R1
  ${IfNot} ${Errors}
    Goto agentic_os_uninit_done            ; /S present -> updater/scripted -> KEEP
  ${EndIf}
  ${If} ${isUpdated}
    Goto agentic_os_uninit_done            ; --updated -> update flow -> KEEP
  ${EndIf}
  ; Genuinely interactive uninstall (the user already confirmed "are you sure").
  ; /SD IDYES is defense-in-depth: if a future template change ever made this
  ; reachable silently, the silent answer is KEEP.
  MessageBox MB_YESNO|MB_ICONQUESTION "Keep your agentic-os data (memory graph, databases, settings)?$\r$\n$\r$\nYES  -  keep it (recommended).$\r$\nNO  -  remove it; it is first MOVED to %APPDATA%\agentic-os-backups\<timestamp> (nothing is deleted — delete that folder yourself later if you are sure)." /SD IDYES IDYES agentic_os_uninit_done IDNO agentic_os_uninit_remove
  agentic_os_uninit_remove:
    StrCpy $agenticRemoveData "1"
  agentic_os_uninit_done:
!macroend

; customUnInstall is inserted at uninstaller.nsh:156-158, BEFORE program-file
; removal and BEFORE the template's own (inert) delete-app-data block. "Remove"
; is a MOVE (Rename) into %APPDATA%\agentic-os-backups\<stamp> — never an RMDir
; of user data. A failed Rename (file lock etc.) leaves the data in place and
; says so; nothing is ever destroyed here.
!macro customUnInstall
  ${If} $agenticRemoveData == "1"
    ${GetTime} "" "L" $R2 $R3 $R4 $R5 $R6 $R7 $R8
    ; ${GetTime} "L" order: day month year dow hour minute second.
    ;   $R2=day $R3=month $R4=year $R6=hour $R7=minute $R8=second
    StrCpy $R9 "$R4$R3$R2-$R6$R7$R8"       ; YYYYMMDD-HHMMSS
    CreateDirectory "$APPDATA\agentic-os-backups"
    ClearErrors
    Rename "$APPDATA\${APP_FILENAME}" "$APPDATA\agentic-os-backups\${APP_FILENAME}-$R9"
    ${If} ${Errors}
      MessageBox MB_OK|MB_ICONEXCLAMATION "Could not move your agentic-os data folder (it may still be in use). Your data was LEFT UNTOUCHED at $APPDATA\${APP_FILENAME} — nothing was deleted." /SD IDOK
    ${EndIf}
  ${EndIf}
!macroend
