' Menjalankan server POS tanpa jendela cmd yang terlihat — dipanggil oleh
' Windows Scheduled Task "POS Server AutoStart" saat login, supaya server
' otomatis jalan tiap komputer dinyalakan tanpa perlu buka terminal manual.
' 0 = jendela disembunyikan. False = tidak menunggu proses selesai (server
' memang harus terus jalan di background).
Set objShell = CreateObject("WScript.Shell")
objShell.CurrentDirectory = "C:\angling\POS\server"
objShell.Run "C:\Program Files\nodejs\node.exe src\server.js", 0, False
