-- Herdr Open: hand every opened file to the editor mod of the running Herdr window.
on open theItems
	repeat with anItem in theItems
		set thePath to POSIX path of anItem
		try
			do shell script "\"${HERDR_APP_HOME:-$HOME/.config/herdr-app}/mods/@MOD@/hv-open\" " & quoted form of thePath
		end try
	end repeat
end open

on run
end run
