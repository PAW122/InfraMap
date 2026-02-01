package monitoring

import (
	"strconv"
	"sync"
	"time"

	"inframap/internal/model"
)

type Logger interface {
	Add(level, source, message string)
}

type PingManager struct {
	mu       sync.RWMutex
	settings model.MonitoringSettings
	nodes    []model.Node
	status   map[string]model.PingResult
	updateCh chan struct{}
	logger   Logger
}

func NewPingManager(logger Logger) *PingManager {
	manager := &PingManager{
		settings: defaultMonitoringSettings(),
		status:   make(map[string]model.PingResult),
		updateCh: make(chan struct{}, 1),
		logger:   logger,
	}
	go manager.loop()
	return manager
}

func defaultMonitoringSettings() model.MonitoringSettings {
	return model.MonitoringSettings{
		Enabled:     false,
		IntervalSec: 30,
		ShowStatus:  false,
	}
}

func sanitizeMonitoringSettings(settings model.MonitoringSettings) model.MonitoringSettings {
	if settings.IntervalSec == 0 {
		if !settings.Enabled && !settings.ShowStatus {
			settings.ShowStatus = defaultMonitoringSettings().ShowStatus
		}
		settings.IntervalSec = defaultMonitoringSettings().IntervalSec
	}
	if settings.IntervalSec < 5 || settings.IntervalSec > 3600 {
		settings.IntervalSec = defaultMonitoringSettings().IntervalSec
	}
	return settings
}

func (m *PingManager) UpdateFromBoard(board *model.Board) {
	settings := sanitizeMonitoringSettings(board.Meta.Monitoring)
	m.mu.Lock()
	settings.Enabled = anyPingEnabled(board.Nodes)
	m.settings = settings
	m.nodes = board.Nodes
	m.mu.Unlock()
	m.signalUpdate()
}

func (m *PingManager) UpdateNodes(nodes []model.Node) {
	m.mu.Lock()
	m.nodes = nodes
	m.settings.Enabled = anyPingEnabled(nodes)
	m.mu.Unlock()
	m.signalUpdate()
}

func (m *PingManager) SetSettings(settings model.MonitoringSettings) {
	settings = sanitizeMonitoringSettings(settings)
	m.mu.Lock()
	settings.Enabled = anyPingEnabled(m.nodes)
	m.settings = settings
	m.mu.Unlock()
	m.signalUpdate()
}

func (m *PingManager) GetSettings() model.MonitoringSettings {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.settings
}

func (m *PingManager) GetStatus() map[string]model.PingResult {
	m.mu.RLock()
	defer m.mu.RUnlock()
	copyMap := make(map[string]model.PingResult, len(m.status))
	for key, value := range m.status {
		copyMap[key] = value
	}
	return copyMap
}

func (m *PingManager) signalUpdate() {
	select {
	case m.updateCh <- struct{}{}:
	default:
	}
}

func (m *PingManager) loop() {
	var ticker *time.Ticker
	currentInterval := 0
	for {
		m.mu.RLock()
		settings := m.settings
		m.mu.RUnlock()

		if !settings.Enabled {
			if ticker != nil {
				ticker.Stop()
				ticker = nil
				currentInterval = 0
			}
			select {
			case <-m.updateCh:
				continue
			case <-time.After(1 * time.Second):
				continue
			}
		}

		if settings.IntervalSec <= 0 {
			settings.IntervalSec = defaultMonitoringSettings().IntervalSec
		}
		if ticker == nil || settings.IntervalSec != currentInterval {
			if ticker != nil {
				ticker.Stop()
			}
			ticker = time.NewTicker(time.Duration(settings.IntervalSec) * time.Second)
			currentInterval = settings.IntervalSec
		}

		select {
		case <-ticker.C:
			m.runPingCycle()
		case <-m.updateCh:
			if m.isEnabled() {
				m.runPingCycle()
			}
			continue
		}
	}
}

func (m *PingManager) isEnabled() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.settings.Enabled
}

func (m *PingManager) runPingCycle() {
	nodes := m.getNodesSnapshot()
	statusSnapshot := m.getStatusSnapshot()
	settings := m.GetSettings()
	results := make(map[string]model.PingResult, len(nodes))
	var wg sync.WaitGroup
	var resultsMu sync.Mutex
	sem := make(chan struct{}, 8)

	for _, node := range nodes {
		if node.Type == "network" || !isPingEnabled(node) {
			continue
		}
		interval := intervalForNode(node, settings.IntervalSec)
		if interval > 0 {
			if last, ok := statusSnapshot[node.ID]; ok {
				if time.Since(last.LastChecked) < interval {
					continue
				}
			}
		}
		target := pickTarget(node)
		if target == "" {
			resultsMu.Lock()
			results[node.ID] = model.PingResult{
				Online:      false,
				LastChecked: time.Now().UTC(),
				Target:      "",
				Error:       "no ip",
			}
			resultsMu.Unlock()
			m.log("warn", "ping", "ping skipped for "+node.ID+": no ip")
			continue
		}

		wg.Add(1)
		go func(nodeID, target string) {
			defer wg.Done()
			sem <- struct{}{}
			result := pingTarget(target)
			<-sem
			resultsMu.Lock()
			results[nodeID] = result
			resultsMu.Unlock()
			level := "info"
			if !result.Online {
				level = "warn"
			}
			msg := "ping " + nodeID + " -> online=" + strconv.FormatBool(result.Online) + " rtt=" + strconv.Itoa(result.RTTMs) + "ms error=" + result.Error
			m.log(level, "ping", msg)
		}(node.ID, target)
	}

	wg.Wait()
	m.mu.Lock()
	if m.status == nil {
		m.status = make(map[string]model.PingResult)
	}
	nodeIDs := make(map[string]struct{}, len(nodes))
	for _, node := range nodes {
		nodeIDs[node.ID] = struct{}{}
	}
	for id, res := range results {
		m.status[id] = res
	}
	for id := range m.status {
		if _, ok := nodeIDs[id]; !ok {
			delete(m.status, id)
		}
	}
	m.mu.Unlock()
}

func (m *PingManager) getNodesSnapshot() []model.Node {
	m.mu.RLock()
	defer m.mu.RUnlock()
	nodes := make([]model.Node, len(m.nodes))
	copy(nodes, m.nodes)
	return nodes
}

func (m *PingManager) getStatusSnapshot() map[string]model.PingResult {
	m.mu.RLock()
	defer m.mu.RUnlock()
	snapshot := make(map[string]model.PingResult, len(m.status))
	for key, value := range m.status {
		snapshot[key] = value
	}
	return snapshot
}

func intervalForNode(node model.Node, fallback int) time.Duration {
	interval := node.PingIntervalSec
	if interval <= 0 {
		interval = fallback
	}
	if interval <= 0 {
		interval = defaultMonitoringSettings().IntervalSec
	}
	if interval <= 0 {
		return 0
	}
	return time.Duration(interval) * time.Second
}

func anyPingEnabled(nodes []model.Node) bool {
	for _, node := range nodes {
		if isPingEnabled(node) {
			return true
		}
	}
	return false
}

func isPingEnabled(node model.Node) bool {
	if node.PingEnabled == nil {
		return false
	}
	return *node.PingEnabled
}

func pickTarget(node model.Node) string {
	if node.IPPublic != "" {
		return node.IPPublic
	}
	if node.IPPrivate != "" {
		return node.IPPrivate
	}
	if node.IPTailscale != "" {
		return node.IPTailscale
	}
	return ""
}

func (m *PingManager) log(level, source, message string) {
	if m.logger == nil {
		return
	}
	m.logger.Add(level, source, message)
}
