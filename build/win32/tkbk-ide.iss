; TKBK IDE — Inno Setup script (per-user install by default, admin install via dialog).
; Compiled by build/build.mjs with /D defines:
;   AppVersion, FileVersion, SourceDir, OutputDir, SetupIcon, AppId, AppMutex

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef FileVersion
  #define FileVersion "0.0.0.0"
#endif
#ifndef AppId
  #define AppId "3A9D1F6C-8B2E-4D7A-A5C1-6F0E9B8D7C21"
#endif
#ifndef AppMutex
  #define AppMutex "tkbkide"
#endif
#define MyAppName "TKBK IDE"
#define MyAppExeName "TKBK IDE.exe"
#define MyAppPublisher "TKBK"
#define MyAppURL "https://tkbk.online"
#define MyCli "tkbk-ide"

[Setup]
AppId={{{#AppId}}
AppName={#MyAppName}
AppVersion={#AppVersion}
AppVerName={#MyAppName} {#AppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL=https://github.com/tkbk-online/tkbk-ide/issues
AppUpdatesURL=https://github.com/tkbk-online/tkbk-ide/releases
AppCopyright=Copyright (C) 2026 TKBK
VersionInfoVersion={#FileVersion}
VersionInfoProductName={#MyAppName}
VersionInfoDescription={#MyAppName} Setup
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir={#OutputDir}
OutputBaseFilename=TKBK-IDE-Setup-win32-x64-{#AppVersion}
SetupIconFile={#SetupIcon}
UninstallDisplayIcon={app}\{#MyAppExeName}
UninstallDisplayName={#MyAppName}
Compression=lzma2/max
SolidCompression=yes
LZMAUseSeparateProcess=yes
LZMANumBlockThreads=4
WizardStyle=modern
CloseApplications=yes
RestartApplications=no
ChangesEnvironment=yes
ChangesAssociations=yes
AppMutex={#AppMutex}
SetupMutex={#AppMutex}setup

[Languages]
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[CustomMessages]
russian.AddToPath=Добавить команду «{#MyCli}» в PATH (нужен перезапуск терминала)
english.AddToPath=Add "{#MyCli}" command to PATH (requires shell restart)
russian.ContextFiles=Добавить «Открыть в {#MyAppName}» в контекстное меню файлов
english.ContextFiles=Add "Open with {#MyAppName}" action to file context menu
russian.ContextFolders=Добавить «Открыть в {#MyAppName}» в контекстное меню папок
english.ContextFolders=Add "Open with {#MyAppName}" action to directory context menu
russian.InstallingExtensions=Установка расширений TKBK...
english.InstallingExtensions=Installing TKBK extensions...
russian.OpenWith=Открыть в {#MyAppName}
english.OpenWith=Open with {#MyAppName}

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"
Name: "addcontextmenufiles"; Description: "{cm:ContextFiles}"; GroupDescription: "{cm:AdditionalIcons}"
Name: "addcontextmenufolders"; Description: "{cm:ContextFolders}"; GroupDescription: "{cm:AdditionalIcons}"
Name: "addtopath"; Description: "{cm:AddToPath}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; AppUserModelID: "TKBK.TKBKIDE"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon; AppUserModelID: "TKBK.TKBKIDE"

[Registry]
; "Open with TKBK IDE" for files
Root: HKA; Subkey: "Software\Classes\*\shell\{#MyAppName}"; ValueType: expandsz; ValueName: ""; ValueData: "{cm:OpenWith}"; Tasks: addcontextmenufiles; Flags: uninsdeletekey
Root: HKA; Subkey: "Software\Classes\*\shell\{#MyAppName}"; ValueType: expandsz; ValueName: "Icon"; ValueData: "{app}\{#MyAppExeName}"; Tasks: addcontextmenufiles
Root: HKA; Subkey: "Software\Classes\*\shell\{#MyAppName}\command"; ValueType: expandsz; ValueName: ""; ValueData: """{app}\{#MyAppExeName}"" ""%1"""; Tasks: addcontextmenufiles
; for folders and folder background
Root: HKA; Subkey: "Software\Classes\Directory\shell\{#MyAppName}"; ValueType: expandsz; ValueName: ""; ValueData: "{cm:OpenWith}"; Tasks: addcontextmenufolders; Flags: uninsdeletekey
Root: HKA; Subkey: "Software\Classes\Directory\shell\{#MyAppName}"; ValueType: expandsz; ValueName: "Icon"; ValueData: "{app}\{#MyAppExeName}"; Tasks: addcontextmenufolders
Root: HKA; Subkey: "Software\Classes\Directory\shell\{#MyAppName}\command"; ValueType: expandsz; ValueName: ""; ValueData: """{app}\{#MyAppExeName}"" ""%V"""; Tasks: addcontextmenufolders
Root: HKA; Subkey: "Software\Classes\Directory\Background\shell\{#MyAppName}"; ValueType: expandsz; ValueName: ""; ValueData: "{cm:OpenWith}"; Tasks: addcontextmenufolders; Flags: uninsdeletekey
Root: HKA; Subkey: "Software\Classes\Directory\Background\shell\{#MyAppName}"; ValueType: expandsz; ValueName: "Icon"; ValueData: "{app}\{#MyAppExeName}"; Tasks: addcontextmenufolders
Root: HKA; Subkey: "Software\Classes\Directory\Background\shell\{#MyAppName}\command"; ValueType: expandsz; ValueName: ""; ValueData: """{app}\{#MyAppExeName}"" ""%V"""; Tasks: addcontextmenufolders
; URL protocol tkbk-ide://
Root: HKA; Subkey: "Software\Classes\tkbk-ide"; ValueType: string; ValueName: ""; ValueData: "URL:{#MyAppName}"; Flags: uninsdeletekey
Root: HKA; Subkey: "Software\Classes\tkbk-ide"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""
Root: HKA; Subkey: "Software\Classes\tkbk-ide\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\{#MyAppExeName}"
Root: HKA; Subkey: "Software\Classes\tkbk-ide\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#MyAppExeName}"" --open-url -- ""%1"""

[Run]
Filename: "{app}\resources\app\bundled-extensions\install.cmd"; StatusMsg: "{cm:InstallingExtensions}"; Flags: runhidden waituntilterminated
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#MyAppName}}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{app}"

[Code]
const
  EnvKey = 'Environment';

function NeedsAddPath(Param: string): boolean;
var
  OrigPath: string;
begin
  if not RegQueryStringValue(HKCU, EnvKey, 'Path', OrigPath) then
  begin
    Result := True;
    exit;
  end;
  Result := Pos(';' + Uppercase(Param) + ';', ';' + Uppercase(OrigPath) + ';') = 0;
end;

procedure AddToPath(Dir: string);
var
  OrigPath: string;
begin
  if not NeedsAddPath(Dir) then exit;
  if not RegQueryStringValue(HKCU, EnvKey, 'Path', OrigPath) then OrigPath := '';
  if (OrigPath <> '') and (OrigPath[Length(OrigPath)] <> ';') then OrigPath := OrigPath + ';';
  RegWriteExpandStringValue(HKCU, EnvKey, 'Path', OrigPath + Dir);
end;

procedure RemoveFromPath(Dir: string);
var
  OrigPath, NewPath: string;
  P: Integer;
begin
  if not RegQueryStringValue(HKCU, EnvKey, 'Path', OrigPath) then exit;
  NewPath := ';' + OrigPath + ';';
  P := Pos(';' + Uppercase(Dir) + ';', Uppercase(NewPath));
  if P = 0 then exit;
  Delete(NewPath, P, Length(Dir) + 1);
  NewPath := Copy(NewPath, 2, Length(NewPath) - 2);
  RegWriteExpandStringValue(HKCU, EnvKey, 'Path', NewPath);
end;

// Russian UI from the first start: ~/.tkbk-ide/argv.json (only when absent).
procedure WriteArgvJson();
var
  Dir, FileName: string;
begin
  Dir := ExpandConstant('{%USERPROFILE}') + '\.tkbk-ide';
  FileName := Dir + '\argv.json';
  if FileExists(FileName) then exit;
  if not DirExists(Dir) then CreateDir(Dir);
  SaveStringToFile(FileName, '{' + #13#10 + '	"locale": "ru",' + #13#10 + '	"enable-crash-reporter": false' + #13#10 + '}' + #13#10, False);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    if WizardIsTaskSelected('addtopath') then AddToPath(ExpandConstant('{app}\bin'));
    WriteArgvJson();
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
    RemoveFromPath(ExpandConstant('{app}\bin'));
end;
