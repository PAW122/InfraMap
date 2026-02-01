package server

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"inframap/internal/model"
	"inframap/internal/sshutil"
)

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{
		"status": "ok",
		"time":   time.Now().UTC().Format(time.RFC3339),
	})
}

func (s *Server) handleBoard(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		s.serveBoard(w)
	case http.MethodPost:
		s.saveBoard(w, r)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	results := map[string]model.PingResult{}
	if s.ping != nil {
		results = s.ping.GetStatus()
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"updatedAt": time.Now().UTC().Format(time.RFC3339),
		"results":   results,
	})
}

func (s *Server) handleLogs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	limit := 200
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil {
			if parsed > 0 && parsed <= 1000 {
				limit = parsed
			}
		}
	}
	items := []model.LogEntry{}
	if s.logs != nil {
		items = s.logs.List(limit)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"items": items,
	})
}

func (s *Server) handleMonitoring(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		settings := model.MonitoringSettings{}
		if s.ping != nil {
			settings = s.ping.GetSettings()
		}
		writeJSON(w, http.StatusOK, settings)
	case http.MethodPost:
		body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		if err != nil {
			http.Error(w, "failed to read request body", http.StatusBadRequest)
			return
		}
		var settings model.MonitoringSettings
		if err := json.Unmarshal(body, &settings); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		if s.ping != nil {
			s.ping.SetSettings(settings)
		}
		writeJSON(w, http.StatusOK, settings)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) handleMonitoringNodes(w http.ResponseWriter, r *http.Request) {
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
		Nodes []model.Node `json:"nodes"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	if s.ping != nil {
		s.ping.UpdateNodes(payload.Nodes)
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"status": "ok",
	})
}

func (s *Server) handleDeviceSettings(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/device-settings/")
	if id == "" || id == "/" {
		http.Error(w, "missing device id", http.StatusBadRequest)
		return
	}
	if s.secrets == nil {
		http.Error(w, "secrets store not available", http.StatusInternalServerError)
		return
	}
	detect := r.URL.Query().Get("detect") == "1"
	forceDetect := r.URL.Query().Get("force") == "1"

	switch r.Method {
	case http.MethodGet:
		settings, ok, err := s.secrets.Get(id)
		if err != nil {
			http.Error(w, "failed to read device settings", http.StatusInternalServerError)
			return
		}
		if !ok {
			writeJSON(w, http.StatusOK, map[string]any{
				"exists":   false,
				"settings": model.DeviceSettings{},
			})
			return
		}
		if detect && settings.ConnectEnabled {
			if settings.OS == "linux" {
				if settings.LinkSpeedMbps == 0 || forceDetect {
					if s.logs != nil {
						s.logs.Add("info", "ssh", fmt.Sprintf("auto-detect link speed for %s", id))
					}
					speed, iface, detErr := sshutil.DetectLinkSpeed(settings, 8*time.Second)
					if detErr != nil {
						if s.logs != nil {
							s.logs.Add("warn", "ssh", fmt.Sprintf("ethtool failed for %s: %v", id, detErr))
						}
					} else if speed > 0 {
						settings.LinkSpeedMbps = speed
						if s.logs != nil {
							s.logs.Add("info", "ssh", fmt.Sprintf("link speed %d Mbps detected for %s (%s)", speed, id, iface))
						}
						_ = s.secrets.Set(id, settings)
					}
				}
			} else if s.logs != nil {
				s.logs.Add("info", "ssh", fmt.Sprintf("link speed detection skipped for %s (os=%s)", id, settings.OS))
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"exists":   true,
			"settings": settings,
		})
	case http.MethodPost:
		body, err := io.ReadAll(io.LimitReader(r.Body, 2<<20))
		if err != nil {
			http.Error(w, "failed to read request body", http.StatusBadRequest)
			return
		}
		var settings model.DeviceSettings
		if err := json.Unmarshal(body, &settings); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		prevSettings, prevExists, prevErr := s.secrets.Get(id)
		if prevErr != nil && s.logs != nil {
			s.logs.Add("warn", "settings", fmt.Sprintf("failed to read previous settings for %s: %v", id, prevErr))
		}
		settings = sanitizeDeviceSettings(settings)
		if s.logs != nil {
			s.logs.Add("info", "settings", fmt.Sprintf("settings received for %s (connect=%t os=%s host=%s)", id, settings.ConnectEnabled, settings.OS, settings.Host))
		}
		if settings.ConnectEnabled && settings.OS == "linux" {
			speed, iface, err := sshutil.DetectLinkSpeed(settings, 8*time.Second)
			if err != nil {
				if s.logs != nil {
					s.logs.Add("warn", "ssh", fmt.Sprintf("ethtool failed for %s: %v", id, err))
				}
			} else if speed > 0 {
				settings.LinkSpeedMbps = speed
				if s.logs != nil {
					s.logs.Add("info", "ssh", fmt.Sprintf("link speed %d Mbps detected for %s (%s)", speed, id, iface))
				}
			}
		} else if settings.ConnectEnabled && s.logs != nil {
			s.logs.Add("info", "ssh", fmt.Sprintf("link speed detection skipped for %s (os=%s)", id, settings.OS))
		}
		if err := s.secrets.Set(id, settings); err != nil {
			http.Error(w, "failed to save device settings", http.StatusInternalServerError)
			return
		}
		if s.logs != nil {
			if prevExists {
				if prevSettings.ConnectEnabled != settings.ConnectEnabled {
					action := "disabled"
					if settings.ConnectEnabled {
						action = "enabled"
					}
					s.logs.Add("info", "ssh", fmt.Sprintf("SSH connection %s for %s", action, id))
				}
			} else if settings.ConnectEnabled {
				s.logs.Add("info", "ssh", fmt.Sprintf("SSH connection enabled for %s", id))
			}
			if settings.ConnectEnabled {
				host := settings.Host
				if host == "" {
					host = "unset"
				}
				port := settings.Port
				if port == 0 {
					port = 22
				}
				user := settings.Username
				if user == "" {
					user = "unset"
				}
				s.logs.Add("info", "ssh", fmt.Sprintf("SSH settings saved for %s (host=%s port=%d user=%s)", id, host, port, user))
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"status":   "saved",
			"settings": settings,
		})
	case http.MethodDelete:
		if err := s.secrets.Delete(id); err != nil {
			http.Error(w, "failed to delete device settings", http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{
			"status": "deleted",
		})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func sanitizeDeviceSettings(settings model.DeviceSettings) model.DeviceSettings {
	settings.OS = strings.ToLower(strings.TrimSpace(settings.OS))
	if settings.OS == "" {
		settings.OS = "linux"
	}
	settings.Host = strings.TrimSpace(settings.Host)
	if settings.Port == 0 {
		settings.Port = 22
	}
	settings.AuthMethod = strings.ToLower(strings.TrimSpace(settings.AuthMethod))
	if settings.AuthMethod == "" {
		settings.AuthMethod = "password"
	}
	if settings.LinkSpeedMbps < 0 {
		settings.LinkSpeedMbps = 0
	}
	if settings.AuthMethod == "password" {
		settings.PrivateKey = ""
		settings.PrivateKeyPassphrase = ""
	}
	if settings.AuthMethod == "ssh_key" {
		settings.Password = ""
	}
	settings.Username = strings.TrimSpace(settings.Username)
	return settings
}
