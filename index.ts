import { exec } from 'node:child_process';
import { platform } from 'node:os';
import { promises as fs } from 'node:fs';

/**
 * Finds the port numbers used by a process with the given PID.
 * Supports Windows, macOS, Linux, and Docker (Linux-based).
 * @param pid - The process ID to inspect.
 * @returns A promise that resolves to an array of port numbers (as strings) or null if none found.
 */
export async function findPortByPid(pid: number): Promise<string[] | null> {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error('Invalid PID');
  }

  const currentPlatform = platform();

  if (currentPlatform === 'win32') {
    // Windows: Use PowerShell to get ports by matching OwningProcess.
    return new Promise((resolve, reject) => {
      const command = `powershell -Command "Get-NetTCPConnection | Where-Object { $_.OwningProcess -eq ${pid} } | Select-Object -ExpandProperty LocalPort"`;
      exec(command, (error: { message: any; }, stdout: string, stderr: any) => {
        if (error) {
          reject(new Error(stderr || error.message));
          return;
        }
        const trimmed = stdout.trim();
        if (!trimmed) {
          resolve(null);
          return;
        }
        // Each line should be a port number.
        const ports = trimmed.split('\n').map((line: string) => line.trim()).filter(Boolean);
        resolve(ports.length > 0 ? ports : null);
      });
    });
  } else if (currentPlatform === 'darwin') {
    // macOS: Use lsof to list network connections and grep for the PID.
    return new Promise((resolve, reject) => {
      // Using grep -w to match the whole PID
      const command = `lsof -i -P -n | grep -w ${pid}`;
      exec(command, (error: any, stdout: string, stderr: any) => {
        // If the command fails (e.g., no matching lines), resolve as null.
        if (error) {
          resolve(null);
          return;
        }
        const trimmed = stdout.trim();
        if (!trimmed) {
          resolve(null);
          return;
        }
        const ports: string[] = [];
        const lines = trimmed.split('\n');
        for (const line of lines) {
          // lsof output can vary, so we scan for parts containing a colon.
          const parts = line.split(/\s+/);
          for (const part of parts) {
            if (part.includes(':')) {
              const maybePort = part.split(':').pop();
              if (maybePort && /^\d+$/.test(maybePort) && !ports.includes(maybePort)) {
                ports.push(maybePort);
              }
            }
          }
        }
        resolve(ports.length > 0 ? ports : null);
      });
    });
  } else if (currentPlatform === 'linux') {
    // Linux (and Docker): Use /proc to determine which ports are bound by the given PID.
    try {
      const inodeSet = await getSocketInodesForPid(pid);
      if (inodeSet.size === 0) {
        return null;
      }
      // Read both IPv4 and IPv6 TCP connections.
      const tcpPorts = await getPortsFromProcNet('/proc/net/tcp', inodeSet);
      const tcp6Ports = await getPortsFromProcNet('/proc/net/tcp6', inodeSet);
      const allPorts = Array.from(new Set([...tcpPorts, ...tcp6Ports]));
      return allPorts.length > 0 ? allPorts : null;
    } catch (err: any) {
      throw new Error(`Error reading Linux network info: ${err.message}`);
    }
  } else {
    throw new Error(`Unsupported platform: ${currentPlatform}`);
  }
}

/**
 * Reads /proc/[pid]/fd to find inodes corresponding to socket descriptors.
 * @param pid - Process ID.
 * @returns A set of inode numbers (as strings) for socket file descriptors.
 */
async function getSocketInodesForPid(pid: number): Promise<Set<string>> {
  const inodeSet = new Set<string>();
  const fdDir = `/proc/${pid}/fd`;
  let files: string[];
  try {
    files = await fs.readdir(fdDir);
  } catch (err: any) {
    throw new Error(`Unable to read fd directory: ${err.message}`);
  }
  for (const file of files) {
    try {
      const fullPath = `${fdDir}/${file}`;
      const link = await fs.readlink(fullPath);
      const socketMatch = link.match(/^socket:\[(\d+)\]$/);
      if (socketMatch) {
        inodeSet.add(socketMatch[1]);
      }
    } catch {
      // Ignore errors for individual file descriptors.
    }
  }
  return inodeSet;
}

/**
 * Reads a /proc/net/tcp(6) file to match socket inodes and extract the local port.
 * @param filePath - Path to the /proc/net/tcp or /proc/net/tcp6 file.
 * @param inodeSet - A set of inode numbers (as strings) to match.
 * @returns An array of port numbers (as strings) extracted from matching lines.
 */
async function getPortsFromProcNet(filePath: string, inodeSet: Set<string>): Promise<string[]> {
  const ports: string[] = [];
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch {
    // If the file does not exist, return an empty array.
    return [];
  }
  const lines = content.split('\n');
  // Skip the header line.
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    // Expect at least 10 columns; inode is typically at index 9.
    if (parts.length < 10) continue;
    const inode = parts[9];
    if (inodeSet.has(inode)) {
      const localAddress = parts[1];
      // Format: "0100007F:0016" (hex IP and hex port). Extract the port.
      const colonIndex = localAddress.indexOf(':');
      if (colonIndex !== -1) {
        const portHex = localAddress.substring(colonIndex + 1);
        const portDec = parseInt(portHex, 16).toString();
        if (!ports.includes(portDec)) {
          ports.push(portDec);
        }
      }
    }
  }
  return ports;
}
