package storage

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"inframap/internal/model"
)

type SecretsFile struct {
	Version   int               `json:"version"`
	UpdatedAt string            `json:"updatedAt"`
	Items     map[string]string `json:"items"`
}

type SecretStore struct {
	mu   sync.Mutex
	key  []byte
	path string
}

func NewSecretStore(keyPath, dataPath string) (*SecretStore, error) {
	key, err := loadOrCreateKey(keyPath)
	if err != nil {
		return nil, err
	}
	return &SecretStore{
		key:  key,
		path: dataPath,
	}, nil
}

func (s *SecretStore) Get(id string) (model.DeviceSettings, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	file, err := s.load()
	if err != nil {
		return model.DeviceSettings{}, false, err
	}
	blob, ok := file.Items[id]
	if !ok {
		return model.DeviceSettings{}, false, nil
	}
	plaintext, err := decryptPayload(s.key, blob)
	if err != nil {
		return model.DeviceSettings{}, false, err
	}
	var settings model.DeviceSettings
	if err := json.Unmarshal(plaintext, &settings); err != nil {
		return model.DeviceSettings{}, false, err
	}
	return settings, true, nil
}

func (s *SecretStore) Set(id string, settings model.DeviceSettings) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	file, err := s.load()
	if err != nil {
		return err
	}
	raw, err := json.Marshal(settings)
	if err != nil {
		return err
	}
	blob, err := encryptPayload(s.key, raw)
	if err != nil {
		return err
	}
	file.Items[id] = blob
	file.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	return s.save(file)
}

func (s *SecretStore) Delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	file, err := s.load()
	if err != nil {
		return err
	}
	delete(file.Items, id)
	file.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	return s.save(file)
}

func (s *SecretStore) load() (*SecretsFile, error) {
	if _, err := os.Stat(s.path); err != nil {
		if os.IsNotExist(err) {
			return &SecretsFile{
				Version:   1,
				UpdatedAt: time.Now().UTC().Format(time.RFC3339),
				Items:     make(map[string]string),
			}, nil
		}
		return nil, err
	}
	data, err := os.ReadFile(s.path)
	if err != nil {
		return nil, err
	}
	var file SecretsFile
	if err := json.Unmarshal(data, &file); err != nil {
		return nil, err
	}
	if file.Items == nil {
		file.Items = make(map[string]string)
	}
	if file.Version == 0 {
		file.Version = 1
	}
	return &file, nil
}

func (s *SecretStore) save(file *SecretsFile) error {
	payload, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.path, payload, 0o600)
}

func loadOrCreateKey(path string) ([]byte, error) {
	if _, err := os.Stat(path); err == nil {
		raw, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(raw)))
		if err != nil {
			return nil, err
		}
		if len(decoded) != 32 {
			return nil, fmt.Errorf("invalid secret key length")
		}
		return decoded, nil
	}

	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return nil, err
	}
	encoded := base64.StdEncoding.EncodeToString(key)
	if err := os.WriteFile(path, []byte(encoded), 0o600); err != nil {
		return nil, err
	}
	return key, nil
}

func encryptPayload(key, plaintext []byte) (string, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	ciphertext := gcm.Seal(nil, nonce, plaintext, nil)
	combined := append(nonce, ciphertext...)
	return base64.StdEncoding.EncodeToString(combined), nil
}

func decryptPayload(key []byte, payload string) ([]byte, error) {
	data, err := base64.StdEncoding.DecodeString(payload)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	if len(data) < gcm.NonceSize() {
		return nil, fmt.Errorf("invalid payload")
	}
	nonce := data[:gcm.NonceSize()]
	ciphertext := data[gcm.NonceSize():]
	return gcm.Open(nil, nonce, ciphertext, nil)
}
