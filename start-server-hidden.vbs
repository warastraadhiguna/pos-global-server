' Menjalankan server POS tanpa jendela cmd yang terlihat — dipanggil oleh
' Windows Scheduled Task "POS Server AutoStart" saat login.
'
' SENGAJA pakai lokasi file INI SENDIRI (WScript.ScriptFullName), bukan path
' absolut hardcode — supaya kalau folder server/ dipindah ke mana pun (drive
' lain, folder lain), file ini TIDAK PERLU diedit lagi. Yang perlu diperbarui
' cuma target path di Scheduled Task-nya sendiri kalau lokasi file .vbs ini
' berubah (Task Scheduler menyimpan path lengkap ke file ini, bukan ke
' folder induknya).
Set objFSO = CreateObject("Scripting.FileSystemObject")
scriptDir = objFSO.GetParentFolderName(WScript.ScriptFullName)

Set objShell = CreateObject("WScript.Shell")
objShell.CurrentDirectory = scriptDir
' "node" tanpa path lengkap — mengandalkan PATH sistem (berlaku di komputer
' mana pun yang sudah pernah install Node.js secara normal).
objShell.Run "node src\server.js", 0, False
