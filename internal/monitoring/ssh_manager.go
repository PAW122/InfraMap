package monitoring

import (
	"sync"
	"time"

	"inframap/internal/model"
	"inframap/internal/sshutil"
)

type DeviceSettingsProvider interface {
	Get(id string) (model.DeviceSettings, bool, error)
}

type SSHStatusManager struct {
	mu       sync.RWMutex
	nodes    []model.Node
	status   map[string]model.SSHStatus
	updateCh chan struct{}
	interval time.Duration
	provider DeviceSettingsProvider
	logger   Logger
}

func NewSSHStatusManager(provider DeviceSettingsProvider, logger Logger) *SSHStatusManager {
	m := &SSHStatusManager{
		status:   make(map[string]model.SSHStatus),
		updateCh: make(chan struct{}, 1),
		interval: 30 * time.Second,
		provider: provider,
		logger:   logger,
	}
	go m.loop()
	return m
}

func (m *SSHStatusManager) UpdateNodes(nodes []model.Node) {
	m.mu.Lock()
	m.nodes = nodes
	m.mu.Unlock()
	m.signalUpdate()
}

func (m *SSHStatusManager) GetStatus() map[string]model.SSHStatus {
	m.mu.RLock()
	defer m.mu.RUnlock()
	copyMap := make(map[string]model.SSHStatus, len(m.status))
	for key, value := range m.status {
		copyMap[key] = value
	}
	return copyMap
}

func (m *SSHStatusManager) signalUpdate() {
	select {
	case m.updateCh <- struct{}{}:
	default:
	}
}

func (m *SSHStatusManager) loop() {
	ticker := time.NewTicker(m.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			m.runCheck()
		case <-m.updateCh:
			m.runCheck()
		}
	}
}

func (m *SSHStatusManager) runCheck() {
	nodes := m.getNodesSnapshot()
	results := make(map[string]model.SSHStatus, len(nodes))
	var wg sync.WaitGroup
	var resultsMu sync.Mutex
	sem := make(chan struct{}, 6)

	for _, node := range nodes {
		if node.Type == "network" || !node.ConnectEnabled {
			continue
		}
		wg.Add(1)
		go func(node model.Node) {
			defer wg.Done()
			sem <- struct{}{}
			status := m.checkNode(node)
			<-sem
			resultsMu.Lock()
			results[node.ID] = status
			resultsMu.Unlock()
		}(node)
	}

	wg.Wait()
	m.mu.Lock()
	if m.status == nil {
		m.status = make(map[string]model.SSHStatus)
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

func (m *SSHStatusManager) checkNode(node model.Node) model.SSHStatus {
	status := model.SSHStatus{Online: false, LastChecked: time.Now().UTC()}
	if m.provider == nil {
		status.Error = "settings provider missing"
		return status
	}
	settings, ok, err := m.provider.Get(node.ID)
	if err != nil {
		status.Error = err.Error()
		return status
	}
	if !ok {
		status.Error = "settings not found"
		return status
	}
	if settings.Host == "" {
		settings.Host = pickTarget(node)
	}
	_, err = sshutil.CheckConnection(settings, 6*time.Second)
	if err != nil {
		status.Error = err.Error()
		return status
	}
	status.Online = true
	return status
}

func (m *SSHStatusManager) getNodesSnapshot() []model.Node {
	m.mu.RLock()
	defer m.mu.RUnlock()
	nodes := make([]model.Node, len(m.nodes))
	copy(nodes, m.nodes)
	return nodes
}
