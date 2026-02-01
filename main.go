package main

import (
	"log"
	"net/http"
	"os"
	"strings"

	"inframap/internal/monitoring"
	"inframap/internal/server"
	"inframap/internal/storage"
)

const (
	dataDir       = "data"
	boardFile     = "data/board.json"
	secretsFile   = "data/secrets.json"
	secretKeyFile = "data/secrets.key"
	staticDir     = "public"
	defaultPort   = "8080"
)

func main() {
	loadDotEnv(".env")
	port := getEnv("PORT", defaultPort)
	addr := ":" + port
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		log.Fatalf("failed to prepare data directory: %v", err)
	}

	logStore := storage.NewLogStore(500)
	secretStore, err := storage.NewSecretStore(secretKeyFile, secretsFile)
	if err != nil {
		log.Fatalf("failed to init secrets store: %v", err)
	}
	pingManager := monitoring.NewPingManager(logStore)
	sshManager := monitoring.NewSSHStatusManager(secretStore, logStore)

	srv := server.New(server.Config{
		DataDir:   dataDir,
		BoardFile: boardFile,
		StaticDir: staticDir,
		Ping:      pingManager,
		SSH:       sshManager,
		Secrets:   secretStore,
		Logs:      logStore,
	})

	if err := srv.Bootstrap(); err != nil {
		log.Printf("bootstrap warning: %v", err)
	}

	log.Printf("InfraMap server listening on http://localhost%s", addr)
	if err := http.ListenAndServe(addr, srv.Routes()); err != nil {
		log.Fatal(err)
	}
}

func loadDotEnv(path string) {
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	lines := strings.Split(string(data), "\n")
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		parts := strings.SplitN(trimmed, "=", 2)
		if len(parts) != 2 {
			continue
		}
		key := strings.TrimSpace(parts[0])
		value := strings.TrimSpace(parts[1])
		if key == "" {
			continue
		}
		if _, exists := os.LookupEnv(key); exists {
			continue
		}
		_ = os.Setenv(key, value)
	}
}

func getEnv(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}
