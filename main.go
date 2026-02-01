package main

import (
	"log"
	"net/http"
	"os"

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
	addr          = ":8080"
)

func main() {
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		log.Fatalf("failed to prepare data directory: %v", err)
	}

	logStore := storage.NewLogStore(500)
	pingManager := monitoring.NewPingManager(logStore)
	secretStore, err := storage.NewSecretStore(secretKeyFile, secretsFile)
	if err != nil {
		log.Fatalf("failed to init secrets store: %v", err)
	}

	srv := server.New(server.Config{
		DataDir:   dataDir,
		BoardFile: boardFile,
		StaticDir: staticDir,
		Ping:      pingManager,
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
