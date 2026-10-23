' スタートアップ用: ウィンドウなしで ChatDango のサーバーだけ起動する(ポート使用中なら何もしない)
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
sh.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "powershell -NoProfile -WindowStyle Hidden -Command ""if (-not (Get-NetTCPConnection -LocalPort 5178 -State Listen -ErrorAction SilentlyContinue)) { node server.js }""", 0, False
