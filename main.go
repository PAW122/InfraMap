package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	dataDir   = "data"
	boardFile = "data/board.json"
	addr      = ":8080"
)

var pingManager = NewPingManager()

type MonitoringSettings struct {
	Enabled     bool `json:"enabled"`
	IntervalSec int  `json:"intervalSec"`
	ShowStatus  bool `json:"showStatus"`
}

type BoardMeta struct {
	Monitoring MonitoringSettings `json:"monitoring"`
}

type Node struct {
	ID              string `json:"id"`
	Type            string `json:"type"`
	IPPrivate       string `json:"ipPrivate"`
	IPPublic        string `json:"ipPublic"`
	PingEnabled     *bool  `json:"pingEnabled,omitempty"`
	PingIntervalSec int    `json:"pingIntervalSec,omitempty"`
}

type Board struct {
	Meta  BoardMeta `json:"meta"`
	Nodes []Node    `json:"nodes"`
}

type PingResult struct {
	Online      bool      `json:"online"`
	LastChecked time.Time `json:"lastChecked"`
	RTTMs       int       `json:"rttMs,omitempty"`
	Target      string    `json:"target"`
	Error       string    `json:"error,omitempty"`
}

func main() {
	mux := http.NewServeMux()
	mux.Handle("/", http.FileServer(http.Dir("public")))
	mux.HandleFunc("/api/health", handleHealth)
	mux.HandleFunc("/api/board", handleBoard)
	mux.HandleFunc("/api/status", handleStatus)
	mux.HandleFunc("/api/monitoring", handleMonitoring)
	mux.HandleFunc("/api/monitoring/nodes", handleMonitoringNodes)

	bootstrapManager()
	log.Printf("InfraMap server listening on http://localhost%s", addr)
	if err := http.ListenAndServe(addr, withLogging(mux)); err != nil {
		log.Fatal(err)
	}
}

func handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{
		"status": "ok",
		"time":   time.Now().UTC().Format(time.RFC3339),
	})
}

func handleBoard(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		serveBoard(w)
	case http.MethodPost:
		saveBoard(w, r)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func handleStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	results := pingManager.GetStatus()
	writeJSON(w, http.StatusOK, map[string]any{
		"updatedAt": time.Now().UTC().Format(time.RFC3339),
		"results":   results,
	})
}

func handleMonitoring(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, pingManager.GetSettings())
	case http.MethodPost:
		body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		if err != nil {
			http.Error(w, "failed to read request body", http.StatusBadRequest)
			return
		}
		var settings MonitoringSettings
		if err := json.Unmarshal(body, &settings); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		settings = sanitizeMonitoringSettings(settings)
		pingManager.SetSettings(settings)
		writeJSON(w, http.StatusOK, settings)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func handleMonitoringNodes(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 2<<20))
	if err != nil {
		http.Error(w, "failed to read request body", http.StatusBadRequest)
		return
	}
	var payload struct {
		Nodes []Node `json:"nodes"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	pingManager.UpdateNodes(payload.Nodes)
	writeJSON(w, http.StatusOK, map[string]string{
		"status": "ok",
	})
}

func serveBoard(w http.ResponseWriter) {
	if err := ensureDataDir(); err != nil {
		http.Error(w, "failed to prepare data directory", http.StatusInternalServerError)
		return
	}

	if _, err := os.Stat(boardFile); err != nil {
		if !os.IsNotExist(err) {
			http.Error(w, "failed to read board file", http.StatusInternalServerError)
			return
		}
		if err := writeDefaultBoard(); err != nil {
			http.Error(w, "failed to create default board", http.StatusInternalServerError)
			return
		}
	}

	data, err := os.ReadFile(boardFile)
	if err != nil {
		http.Error(w, "failed to read board file", http.StatusInternalServerError)
		return
	}
	updateManagerFromBytes(data)

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

func saveBoard(w http.ResponseWriter, r *http.Request) {
	if err := ensureDataDir(); err != nil {
		http.Error(w, "failed to prepare data directory", http.StatusInternalServerError)
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, 5<<20))
	if err != nil {
		http.Error(w, "failed to read request body", http.StatusBadRequest)
		return
	}

	if !json.Valid(body) {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	updateManagerFromBytes(body)

	var pretty json.RawMessage
	if err := json.Unmarshal(body, &pretty); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}

	indented, err := json.MarshalIndent(pretty, "", "  ")
	if err != nil {
		http.Error(w, "failed to format json", http.StatusInternalServerError)
		return
	}

	if err := os.WriteFile(boardFile, indented, 0o644); err != nil {
		http.Error(w, "failed to write board file", http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{
		"status": "saved",
		"path":   boardFile,
	})
}

func ensureDataDir() error {
	return os.MkdirAll(dataDir, 0o755)
}

func writeDefaultBoard() error {
	defaultBoard := map[string]any{
		"version": 1,
		"meta": map[string]any{
			"name":      "InfraMap",
			"updatedAt": time.Now().UTC().Format(time.RFC3339),
			"monitoring": map[string]any{
				"enabled":     false,
				"intervalSec": 30,
				"showStatus":  false,
			},
		},
		"viewport": map[string]any{
			"x":    0,
			"y":    0,
			"zoom": 1,
		},
		"nodes": []map[string]any{
			{
				"id":              "net-1",
				"type":            "network",
				"label":           "LAN-1",
				"x":               -260,
				"y":               -180,
				"width":           520,
				"height":          320,
				"color":           "#1d6fa3",
				"networkPublicIp": "203.0.113.0/24",
				"notes":           "Primary LAN segment",
			},
			{
				"id":        "node-1",
				"type":      "server",
				"label":     "Server A",
				"x":         -140,
				"y":         -60,
				"network":   "",
				"ipPrivate": "10.0.0.10",
				"ipPublic":  "203.0.113.10",
				"notes":     "Primary app server",
			},
			{
				"id":        "node-2",
				"type":      "router",
				"label":     "Edge Router",
				"x":         120,
				"y":         60,
				"network":   "",
				"ipPrivate": "10.0.0.1",
				"ipPublic":  "198.51.100.1",
				"notes":     "Gateway to ISP",
			},
		},
		"links": []map[string]any{},
	}

	payload, err := json.MarshalIndent(defaultBoard, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(boardFile, payload, 0o644)
}

func bootstrapManager() {
	if err := ensureDataDir(); err != nil {
		log.Printf("monitoring disabled: %v", err)
		return
	}

	if _, err := os.Stat(boardFile); err != nil {
		if os.IsNotExist(err) {
			if err := writeDefaultBoard(); err != nil {
				log.Printf("monitoring disabled: failed to create default board: %v", err)
				return
			}
		} else {
			log.Printf("monitoring disabled: failed to stat board file: %v", err)
			return
		}
	}

	data, err := os.ReadFile(boardFile)
	if err != nil {
		log.Printf("monitoring disabled: failed to read board file: %v", err)
		return
	}
	updateManagerFromBytes(data)
}

func updateManagerFromBytes(data []byte) {
	var board Board
	if err := json.Unmarshal(data, &board); err != nil {
		return
	}
	pingManager.UpdateFromBoard(&board)
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		log.Printf("failed to encode response: %v", err)
	}
}

func withLogging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		start := time.Now()
		next.ServeHTTP(rec, r)
		duration := time.Since(start)
		log.Printf("%s %s %d %s", r.Method, r.URL.Path, rec.status, duration.Round(time.Millisecond))
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(status int) {
	s.status = status
	s.ResponseWriter.WriteHeader(status)
}

func (s *statusRecorder) Write(p []byte) (int, error) {
	if s.status == 0 {
		s.status = http.StatusOK
	}
	return s.ResponseWriter.Write(p)
}

func init() {
	if err := os.MkdirAll(filepath.Dir(boardFile), 0o755); err != nil {
		fmt.Printf("warn: failed to ensure data directory: %v\n", err)
	}
}

type PingManager struct {
	mu       sync.RWMutex
	settings MonitoringSettings
	nodes    []Node
	status   map[string]PingResult
	updateCh chan struct{}
}

func NewPingManager() *PingManager {
	manager := &PingManager{
		settings: defaultMonitoringSettings(),
		status:   make(map[string]PingResult),
		updateCh: make(chan struct{}, 1),
	}
	go manager.loop()
	return manager
}

func defaultMonitoringSettings() MonitoringSettings {
	return MonitoringSettings{
		Enabled:     false,
		IntervalSec: 30,
		ShowStatus:  false,
	}
}

func sanitizeMonitoringSettings(settings MonitoringSettings) MonitoringSettings {
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

func (m *PingManager) UpdateFromBoard(board *Board) {
	settings := sanitizeMonitoringSettings(board.Meta.Monitoring)
	m.mu.Lock()
	settings.Enabled = anyPingEnabled(board.Nodes)
	m.settings = settings
	m.nodes = board.Nodes
	m.mu.Unlock()
	m.signalUpdate()
}

func (m *PingManager) UpdateNodes(nodes []Node) {
	m.mu.Lock()
	m.nodes = nodes
	m.settings.Enabled = anyPingEnabled(nodes)
	m.mu.Unlock()
	m.signalUpdate()
}

func (m *PingManager) SetSettings(settings MonitoringSettings) {
	settings = sanitizeMonitoringSettings(settings)
	m.mu.Lock()
	settings.Enabled = anyPingEnabled(m.nodes)
	m.settings = settings
	m.mu.Unlock()
	m.signalUpdate()
}

func (m *PingManager) GetSettings() MonitoringSettings {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.settings
}

func (m *PingManager) GetStatus() map[string]PingResult {
	m.mu.RLock()
	defer m.mu.RUnlock()
	copyMap := make(map[string]PingResult, len(m.status))
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
			continue
		}
	}
}

func (m *PingManager) runPingCycle() {
	nodes := m.getNodesSnapshot()
	statusSnapshot := m.getStatusSnapshot()
	settings := m.GetSettings()
	results := make(map[string]PingResult, len(nodes))
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
			results[node.ID] = PingResult{
				Online:      false,
				LastChecked: time.Now().UTC(),
				Target:      "",
				Error:       "no ip",
			}
			resultsMu.Unlock()
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
		}(node.ID, target)
	}

	wg.Wait()
	m.mu.Lock()
	if m.status == nil {
		m.status = make(map[string]PingResult)
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

func (m *PingManager) getNodesSnapshot() []Node {
	m.mu.RLock()
	defer m.mu.RUnlock()
	nodes := make([]Node, len(m.nodes))
	copy(nodes, m.nodes)
	return nodes
}

func (m *PingManager) getStatusSnapshot() map[string]PingResult {
	m.mu.RLock()
	defer m.mu.RUnlock()
	snapshot := make(map[string]PingResult, len(m.status))
	for key, value := range m.status {
		snapshot[key] = value
	}
	return snapshot
}

func pickTarget(node Node) string {
	if node.IPPublic != "" {
		return node.IPPublic
	}
	if node.IPPrivate != "" {
		return node.IPPrivate
	}
	return ""
}

func intervalForNode(node Node, fallback int) time.Duration {
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

func anyPingEnabled(nodes []Node) bool {
	for _, node := range nodes {
		if isPingEnabled(node) {
			return true
		}
	}
	return false
}

func isPingEnabled(node Node) bool {
	if node.PingEnabled == nil {
		return false
	}
	return *node.PingEnabled
}

var pingRTTRegex = regexp.MustCompile(`time[=<]([0-9.]+)\s*ms`)

func pingTarget(target string) PingResult {
	start := time.Now().UTC()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	cmd := buildPingCommand(ctx, target)
	output, err := cmd.CombinedOutput()
	result := PingResult{
		Online:      false,
		LastChecked: start,
		RTTMs:       0,
		Target:      target,
	}

	if ctx.Err() == context.DeadlineExceeded {
		result.Error = "timeout"
		return result
	}

	if err == nil {
		result.Online = true
	} else {
		result.Error = "unreachable"
	}

	rtt := parseRTT(string(output))
	if rtt > 0 {
		result.RTTMs = rtt
	}
	return result
}

func parseRTT(output string) int {
	match := pingRTTRegex.FindStringSubmatch(output)
	if len(match) < 2 {
		return 0
	}
	value, err := strconv.ParseFloat(strings.TrimSpace(match[1]), 64)
	if err != nil {
		return 0
	}
	return int(value + 0.5)
}

func buildPingCommand(ctx context.Context, target string) *exec.Cmd {
	switch runtime.GOOS {
	case "windows":
		return exec.CommandContext(ctx, "ping", "-n", "1", "-w", "1000", target)
	case "darwin":
		return exec.CommandContext(ctx, "ping", "-c", "1", "-W", "1000", target)
	case "freebsd", "openbsd", "netbsd":
		return exec.CommandContext(ctx, "ping", "-c", "1", "-W", "1000", target)
	default:
		// Linux (including Debian/Ubuntu)
		return exec.CommandContext(ctx, "ping", "-c", "1", "-W", "1", target)
	}
}
