; U-Time 的 NSIS 安装路径与卸载提示。
; Tauri 已在目录页默认追加产品名，但手输路径和 /D= 可以跳过目录页。
; 旧安装必须留在原路径，才能让 /S /R 自动更新继续原地覆盖。
Var UTimeRemoveResiduals

!macro NSIS_HOOK_PREINSTALL
  ReadRegStr $R7 SHCTX "${MANUPRODUCTKEY}" ""
  ${If} $R7 != "$INSTDIR"
    ${GetFileName} "$INSTDIR" $R8
    ${If} $R8 != "${PRODUCTNAME}"
      StrCpy $INSTDIR "$INSTDIR\${PRODUCTNAME}"
      SetOutPath "$INSTDIR"
      ${IfNot} ${Silent}
        MessageBox MB_ICONINFORMATION|MB_OK "为避免与其他文件混放，U-Time 将安装到独立目录：$\r$\n$INSTDIR"
      ${EndIf}
    ${EndIf}
  ${EndIf}
  DetailPrint "U-Time 安装目录：$INSTDIR"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; 标记安装器创建的专属目录；旧版或共享目录绝不做递归清理。
  FileOpen $R8 "$INSTDIR\_utime_install.marker" w
  ${IfNot} ${Errors}
    FileWrite $R8 "${BUNDLEID}"
    FileClose $R8
  ${EndIf}
  CreateDirectory "$SMPROGRAMS\${STARTMENUFOLDER}"
  CreateShortCut "$SMPROGRAMS\${STARTMENUFOLDER}\卸载 U-Time.lnk" "$INSTDIR\uninstall.exe"
  DetailPrint "U-Time 已安装到 $INSTDIR"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  StrCpy $UTimeRemoveResiduals 0
  DetailPrint "正在卸载 U-Time：$INSTDIR"
  ${If} $DeleteAppDataCheckboxState = 1
    DetailPrint "本次卸载同时删除 U-Time 的本机应用数据"
  ${Else}
    DetailPrint "本次卸载保留 U-Time 的本机应用数据"
  ${EndIf}
  ${If} $UpdateMode <> 1
    ${GetFileName} "$INSTDIR" $R8
    ${If} $R8 == "${PRODUCTNAME}"
    ${AndIf} ${FileExists} "$INSTDIR\_utime_install.marker"
      ${IfNot} ${Silent}
        MessageBox MB_ICONQUESTION|MB_YESNO|MB_DEFBUTTON2 "是否清理安装目录中的残余文件？$\r$\n只处理当前 U-Time 专属目录，不会删除下载目录中的导出文件。" IDYES utime_residual_yes
        Goto utime_residual_done
        utime_residual_yes:
          StrCpy $UTimeRemoveResiduals 1
        utime_residual_done:
      ${EndIf}
    ${Else}
      DetailPrint "旧版或共享安装目录：不会递归清理其他文件"
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$SMPROGRAMS\${STARTMENUFOLDER}\卸载 U-Time.lnk"
  RMDir "$SMPROGRAMS\${STARTMENUFOLDER}"
  ${If} $UTimeRemoveResiduals = 1
    ${GetFileName} "$INSTDIR" $R8
    ${If} $R8 == "${PRODUCTNAME}"
    ${AndIf} ${FileExists} "$INSTDIR\_utime_install.marker"
      ; 拒绝递归删除重解析点（目录联接/符号链接可能指向别处）。
      System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR") i .r9'
      IntOp $R9 $R9 & 0x400
      ${If} $R9 = 0
        RMDir /r "$INSTDIR"
        DetailPrint "已清理 U-Time 安装目录残余文件"
      ${Else}
        DetailPrint "安装目录是链接，已跳过递归清理"
      ${EndIf}
    ${EndIf}
    DeleteRegKey SHCTX "${MANUPRODUCTKEY}"
    DeleteRegKey /ifempty SHCTX "${MANUKEY}"
  ${EndIf}
  Delete "$INSTDIR\_utime_install.marker"
  RMDir "$INSTDIR"
  DetailPrint "U-Time 卸载完成"
!macroend
