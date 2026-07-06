; build/installer.nsh — auto-included by electron-builder (NsisTarget resolves
; getResource(nsis.include, "installer.nsh") from the buildResources dir `build/`).
;
; REINSTALL GUARD (requested): the app ships a oneClick per-user installer
; (electron-builder.yml → nsis.oneClick:true, perMachine:false), which by default
; SILENTLY auto-uninstalls an existing version and reinstalls. This macro makes
; that explicit: if agentic-os is already installed for the current user, PROMPT
; before touching it — remove-and-reinstall only on the user's OK, otherwise
; cancel the install and leave the existing app untouched.
;
; WHY preInit: installer.nsi inserts `preInit` at the very top of .onInit
; (line ~56), BEFORE electron-builder's own auto-uninstall logic runs in
; installUtil.nsh (line ~91). So a "No" here Quits before anything is removed.
;
; WHY HKCU + ${UNINSTALL_REGISTRY_KEY}: the per-user (perMachine:false) installer
; writes its uninstall entry under HKCU\...\Uninstall\<key>; ${UNINSTALL_REGISTRY_KEY}
; is defined by the template's multiUser.nsh. Reading its UninstallString is the
; canonical "is it installed?" probe (installer.nsh writes it, uninstaller.nsh
; deletes it).
;
; WHY /SD IDYES (critical): electron-updater applies auto-updates by running this
; installer SILENTLY (`/S`). A silent run must NOT block on a dialog — /SD IDYES
; makes the silent default "Yes, proceed", so background updates keep working while
; an interactive double-click still shows the prompt.
;
; Core NSIS only (ReadRegStr / StrCmp / MessageBox / Quit) — no LogicLib needed.
; preInit is inserted exactly once, so the labels below cannot collide.

!macro preInit
  ReadRegStr $0 HKCU "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
  StrCmp $0 "" agentic_os_reinstall_ok 0
    MessageBox MB_YESNO|MB_ICONEXCLAMATION "agentic-os is already installed on this computer.$\r$\n$\r$\nRemove the existing version and install this one?$\r$\n$\r$\nYes  -  uninstall the current version, then install (your memory graph and settings are kept).$\r$\nNo  -  cancel this installation and keep the current version." /SD IDYES IDYES agentic_os_reinstall_ok
    ; No (interactive choice) -> cancel; the installed app is left untouched.
    Quit
  agentic_os_reinstall_ok:
!macroend
