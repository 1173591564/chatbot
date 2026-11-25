Set ws = CreateObject("Wscript.Shell")
ws.CurrentDirectory = "C:\Users\11735\Desktop\Projects\chatbot\scripts"
ws.Run "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""C:\Users\11735\Desktop\Projects\chatbot\scripts\start-web.ps1""", 0, False
