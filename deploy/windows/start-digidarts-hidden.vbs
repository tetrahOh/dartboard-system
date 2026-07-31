' Launches start-digidarts.bat with no visible console window.
' Task Scheduler's own "Hidden" setting doesn't suppress console windows for
' tasks running in an interactive session, so wscript's Run with windowstyle 0
' is used instead.
CreateObject("WScript.Shell").Run """C:\DigiDarts\deploy\windows\start-digidarts.bat""", 0, False
