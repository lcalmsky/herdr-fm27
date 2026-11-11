-- Herdr FM27 Open: hand every opened file to the fm-editor mod of the running Herdr window.
on open theItems
	repeat with anItem in theItems
		set thePath to POSIX path of anItem
		try
			do shell script "\"$HOME/.config/herdr-app/mods/fm-editor/hv-open\" " & quoted form of thePath
		end try
	end repeat
end open

on run
end run
