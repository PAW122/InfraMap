package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

const (
	dataDir   = "data"
	boardFile = "data/board.json"
	addr      = ":8080"
)

func main() {
	mux := http.NewServeMux()
	mux.Handle("/", http.FileServer(http.Dir("public")))
	mux.HandleFunc("/api/health", handleHealth)
	mux.HandleFunc("/api/board", handleBoard)

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
