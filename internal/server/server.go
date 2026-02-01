package server

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"

	"inframap/internal/model"
	"inframap/internal/monitoring"
	"inframap/internal/storage"
)

type Config struct {
	DataDir   string
	BoardFile string
	StaticDir string
	Ping      *monitoring.PingManager
	Secrets   *storage.SecretStore
	Logs      *storage.LogStore
}

type Server struct {
	dataDir   string
	boardFile string
	staticDir string
	ping      *monitoring.PingManager
	secrets   *storage.SecretStore
	logs      *storage.LogStore
}

func New(cfg Config) *Server {
	return &Server{
		dataDir:   cfg.DataDir,
		boardFile: cfg.BoardFile,
		staticDir: cfg.StaticDir,
		ping:      cfg.Ping,
		secrets:   cfg.Secrets,
		logs:      cfg.Logs,
	}
}

func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.Handle("/", http.FileServer(http.Dir(s.staticDir)))
	mux.HandleFunc("/api/health", s.handleHealth)
	mux.HandleFunc("/api/board", s.handleBoard)
	mux.HandleFunc("/api/status", s.handleStatus)
	mux.HandleFunc("/api/logs", s.handleLogs)
	mux.HandleFunc("/api/monitoring", s.handleMonitoring)
	mux.HandleFunc("/api/monitoring/nodes", s.handleMonitoringNodes)
	mux.HandleFunc("/api/device-settings/", s.handleDeviceSettings)
	return withLogging(mux)
}

func (s *Server) Bootstrap() error {
	if err := s.ensureDataDir(); err != nil {
		return fmt.Errorf("failed to prepare data directory: %w", err)
	}
	if _, err := os.Stat(s.boardFile); err != nil {
		if os.IsNotExist(err) {
			if err := s.writeDefaultBoard(); err != nil {
				return fmt.Errorf("failed to create default board: %w", err)
			}
		} else {
			return fmt.Errorf("failed to stat board file: %w", err)
		}
	}
	data, err := os.ReadFile(s.boardFile)
	if err != nil {
		return fmt.Errorf("failed to read board file: %w", err)
	}
	s.updateManagerFromBytes(data)
	return nil
}

func (s *Server) ensureDataDir() error {
	if s.dataDir == "" {
		return nil
	}
	return os.MkdirAll(s.dataDir, 0o755)
}

func (s *Server) writeDefaultBoard() error {
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

	return os.WriteFile(s.boardFile, payload, 0o644)
}

func (s *Server) updateManagerFromBytes(data []byte) {
	if s.ping == nil {
		return
	}
	var board model.Board
	if err := json.Unmarshal(data, &board); err != nil {
		return
	}
	s.ping.UpdateFromBoard(&board)
}

func (s *Server) serveBoard(w http.ResponseWriter) {
	if err := s.ensureDataDir(); err != nil {
		http.Error(w, "failed to prepare data directory", http.StatusInternalServerError)
		return
	}

	if _, err := os.Stat(s.boardFile); err != nil {
		if !os.IsNotExist(err) {
			http.Error(w, "failed to read board file", http.StatusInternalServerError)
			return
		}
		if err := s.writeDefaultBoard(); err != nil {
			http.Error(w, "failed to create default board", http.StatusInternalServerError)
			return
		}
	}

	data, err := os.ReadFile(s.boardFile)
	if err != nil {
		http.Error(w, "failed to read board file", http.StatusInternalServerError)
		return
	}
	s.updateManagerFromBytes(data)

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

func (s *Server) saveBoard(w http.ResponseWriter, r *http.Request) {
	if err := s.ensureDataDir(); err != nil {
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
	s.updateManagerFromBytes(body)

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

	if err := os.WriteFile(s.boardFile, indented, 0o644); err != nil {
		http.Error(w, "failed to write board file", http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{
		"status": "saved",
		"path":   s.boardFile,
	})
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		fmt.Printf("warn: failed to encode response: %v\n", err)
	}
}

func withLogging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		start := time.Now()
		next.ServeHTTP(rec, r)
		duration := time.Since(start)
		fmt.Printf("%s %s %d %s\n", r.Method, r.URL.Path, rec.status, duration.Round(time.Millisecond))
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
