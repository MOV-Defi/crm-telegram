set scriptFolder to POSIX path of (path to me)
set projectDir to do shell script "dirname " & quoted form of scriptFolder
tell application "Terminal"
	activate
	do script ("cd " & quoted form of projectDir & " && ./start-local-server.sh")
end tell
