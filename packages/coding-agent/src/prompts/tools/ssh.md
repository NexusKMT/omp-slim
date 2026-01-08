Executes a command on a configured SSH host with optional timeout.
Hosts are discovered from `ssh.json` or `.ssh.json` in the project root.

**IMPORTANT**: Check the host description for OS type (Windows/Linux/macOS) and use appropriate commands:
- Windows: `dir`, `type`, `systeminfo`, `Get-ChildItem`, PowerShell commands
- Linux/macOS: `ls`, `cat`, `uname`, bash commands

## Command structure

- Provide a configured host name from the available hosts list
- Use `cwd` to set the remote working directory (optional)
- Commands run on the remote host's default shell

Output:
- Truncated after 50KB; filter output for large results
- Exit codes and stderr captured
