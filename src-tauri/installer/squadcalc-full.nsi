; SquadCalc 完整版安装包（主程序 + 离线数据，一次装完）
; 结构：程序本体很小；离线数据放在安装目录的 data\ 下；3D 按需下载也落在安装目录。
;       主程序按自身目录下的 sqdata.txt（或默认的 data\）读取离线数据。
; 编译：makensis squadcalc-full.nsi

Unicode true
Name "SquadCalc 完整版"
Caption "SquadCalc 完整版 安装"
OutFile "..\..\SquadCalc_46.1.1_x64-setup.exe"
InstallDir "$LOCALAPPDATA\Programs\SquadCalc"
RequestExecutionLevel user
SetCompressor zlib
ShowInstDetails show
ShowUninstDetails show

!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"

!define MUI_ABORTWARNING
!define MUI_ICON "icon.ico"
!define MUI_UNICON "icon.ico"
!define MUI_FINISHPAGE_RUN "$INSTDIR\SquadCalc.exe"
!define MUI_FINISHPAGE_RUN_TEXT "立即启动 SquadCalc"

!insertmacro MUI_PAGE_WELCOME
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE CheckAppNotRunning
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

Function .onInit
    ; 默认装到 D 盘，避免在 C 盘留任何东西；没有 D 盘才退回用户目录
    IfFileExists "D:\" 0 useUserDir
        StrCpy $INSTDIR "D:\SquadCalc"
        Goto doneInit
    useUserDir:
        StrCpy $INSTDIR "$LOCALAPPDATA\Programs\SquadCalc"
    doneInit:
FunctionEnd

; 目标目录里的程序若还在运行，exe 会被系统占用而无法覆盖（装完仍是旧版本）。
; 离开“选择目录”页时先探测并提示退出程序。
Function CheckAppNotRunning
    IfFileExists "$INSTDIR\SquadCalc.exe" 0 done
    ClearErrors
    FileOpen $9 "$INSTDIR\SquadCalc.exe" a
    IfErrors locked ok
    locked:
        MessageBox MB_OK|MB_ICONSTOP "检测到 SquadCalc 正在运行：$\r$\n$INSTDIR\SquadCalc.exe$\r$\n$\r$\n请先完全退出程序，再继续安装；否则主程序文件无法更新，装完仍是旧版本。"
        Abort
    ok:
        FileClose $9
    done:
FunctionEnd

Section "SquadCalc 主程序 (必需)" SecMain
    SectionIn RO
    SetOutPath "$INSTDIR"
    File "..\target\release\squadcalc-desktop.exe"

    CopyFiles /SILENT "$INSTDIR\squadcalc-desktop.exe" "$INSTDIR\SquadCalc.exe"
    Delete "$INSTDIR\squadcalc-desktop.exe"

    WriteUninstaller "$INSTDIR\uninstall.exe"

    CreateDirectory "$SMPROGRAMS\SquadCalc"
    CreateShortCut "$SMPROGRAMS\SquadCalc\SquadCalc.lnk" "$INSTDIR\SquadCalc.exe"
    CreateShortCut "$SMPROGRAMS\SquadCalc\卸载 SquadCalc.lnk" "$INSTDIR\uninstall.exe"
    CreateShortCut "$DESKTOP\SquadCalc.lnk" "$INSTDIR\SquadCalc.exe"

    WriteRegStr HKCU "Software\SquadCalc" "InstallDir" "$INSTDIR"

    ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SquadCalc" "DisplayName" "SquadCalc - 战术小队助手"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SquadCalc" "DisplayVersion" "46.1.1"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SquadCalc" "Publisher" "SquadCalc"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SquadCalc" "DisplayIcon" "$INSTDIR\SquadCalc.exe"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SquadCalc" "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
    WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SquadCalc" "EstimatedSize" "$0"
    WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SquadCalc" "NoModify" 1
    WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SquadCalc" "NoRepair" 1
SectionEnd

Section "离线数据 (必需)" SecData
    SectionIn RO
    ; 数据放在安装目录下：<安装目录>\data\api\...
    SetOutPath "$INSTDIR\data"
    File /r "..\..\public\api"

    FileOpen $1 "$INSTDIR\sqdata.txt" w
    FileWrite $1 "$INSTDIR\data"
    FileClose $1

    WriteRegStr HKCU "Software\SquadCalc" "DataDir" "$INSTDIR\data"
SectionEnd

Section "Uninstall"
    Delete "$INSTDIR\SquadCalc.exe"
    Delete "$INSTDIR\sqdata.txt"
    Delete "$INSTDIR\uninstall.exe"

    ; 数据目录随安装目录一起清理
    RMDir /r "$INSTDIR\data"
    RMDir /r "$INSTDIR\3d"
    RMDir /r "$INSTDIR\webview2"
    RMDir "$INSTDIR"

    Delete "$SMPROGRAMS\SquadCalc\SquadCalc.lnk"
    Delete "$SMPROGRAMS\SquadCalc\卸载 SquadCalc.lnk"
    RMDir "$SMPROGRAMS\SquadCalc"
    Delete "$DESKTOP\SquadCalc.lnk"

    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SquadCalc"
    DeleteRegKey HKCU "Software\SquadCalc"
SectionEnd
