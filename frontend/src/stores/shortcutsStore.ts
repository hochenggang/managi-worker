// Pinia store：统一维护快捷命令。
// 将原本散落在 CmdsView 中的 localStorage 操作集中到此处，
// 便于导入/导出配置时一并处理。

import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ShortcutItem } from '@/protocol/types'

const STORAGE_KEY = 'shortcuts'

function defaultShortcuts(): ShortcutItem[] {
  return [
    {
      label: 'Status',
      cmd: `system_info=$(uname -a | awk '{print $1, $2, $3}')
cpu_info=$(grep -m 1 "model name" /proc/cpuinfo | cut -d ':' -f 2 | sed 's/^ *//')
cpu_cores=$(grep -c ^processor /proc/cpuinfo)
cpu_usage=$(top -bn1 | grep "Cpu(s)" | sed "s/.*, *\\([0-9.]*\\)%* id.*/\\1/" | awk '{print 100 - $1"%"}')
disk_info=$(df -h | awk '/^\\/dev\\// {print $1, $3"/"$2, "("$5")"}' | tr '\\n' ';' | sed 's/;$/ /')
memory_total=$(free -m | awk '/Mem:/ {print $2}')
memory_used=$(free -m | awk '/Mem:/ {print $3}')
memory_percent=$(free -m | awk '/Mem:/ {printf "%.2f%%", ($3/$2)*100}')

max_network_info=$(awk 'NR > 2 {rx+=$2; tx+=$10} END {printf "%.2fG|%.2fG", rx/1024/1024/1024, tx/1024/1024/1024}' /proc/net/dev)
network_in=$(echo "$max_network_info" | cut -d '|' -f1)
network_out=$(echo "$max_network_info" | cut -d '|' -f2)
load_info=$(awk '{printf "%.2f/%.2f/%.2f", $1, $2, $3}' /proc/loadavg)
process_count=$(ps -e | wc -l)
tcp_connections=$(ss -t | grep -c ESTAB)
udp_connections=$(ss -u | grep -c UNCONN)
uptime_seconds=$(awk '{print int($1)}' /proc/uptime)
uptime_days=$((uptime_seconds / 86400))
echo "System: $system_info"
echo "CPU: $cpu_info $cpu_cores Virtual Core ($cpu_usage)"
echo "Disk: $disk_info"
echo "Memery: $memory_used"M"/$memory_total"M" ($memory_percent)"
echo "Trafic: IN $network_in OUT $network_out"
echo "Load: $load_info"
echo "Process Num: $process_count"
echo "Connections: TCP $tcp_connections UDP $udp_connections"
echo "Uptime: $uptime_days Days"`,
    },
    {
      label: 'Change Password',
      cmd: 'echo "$(whoami):Aabbcc" | sudo chpasswd',
    },
  ]
}

export const useShortcutsStore = defineStore('shortcuts', () => {
  const shortcuts = ref<ShortcutItem[]>([])
  let loaded = false

  function load(): void {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as ShortcutItem[]
        if (Array.isArray(parsed)) {
          shortcuts.value = parsed
        } else {
          shortcuts.value = defaultShortcuts()
        }
      } catch {
        shortcuts.value = defaultShortcuts()
      }
    } else {
      shortcuts.value = defaultShortcuts()
      save()
    }
    loaded = true
  }

  function ensureLoaded(): void {
    if (!loaded) {
      load()
    }
  }

  function save(): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(shortcuts.value))
  }

  function setAll(items: ShortcutItem[]): void {
    shortcuts.value = items
    save()
    loaded = true
  }

  function add(item: ShortcutItem): void {
    shortcuts.value.push(item)
    save()
  }

  function remove(index: number): void {
    shortcuts.value.splice(index, 1)
    save()
  }

  function rename(index: number, label: string): void {
    if (shortcuts.value[index]) {
      shortcuts.value[index].label = label
      save()
    }
  }

  return {
    shortcuts,
    load,
    ensureLoaded,
    setAll,
    add,
    remove,
    rename,
  }
})
