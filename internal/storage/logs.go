package storage

import (
	"sync"
	"time"

	"inframap/internal/model"
)

type LogStore struct {
	mu    sync.Mutex
	items []model.LogEntry
	max   int
}

func NewLogStore(max int) *LogStore {
	if max <= 0 {
		max = 500
	}
	return &LogStore{
		items: make([]model.LogEntry, 0, max),
		max:   max,
	}
}

func (l *LogStore) Add(level, source, message string) {
	if l == nil {
		return
	}
	entry := model.LogEntry{
		Time:    time.Now().UTC().Format(time.RFC3339),
		Level:   level,
		Source:  source,
		Message: message,
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.items) >= l.max {
		copy(l.items, l.items[1:])
		l.items[len(l.items)-1] = entry
		return
	}
	l.items = append(l.items, entry)
}

func (l *LogStore) List(limit int) []model.LogEntry {
	if l == nil {
		return nil
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if limit <= 0 || limit > len(l.items) {
		limit = len(l.items)
	}
	start := len(l.items) - limit
	out := make([]model.LogEntry, limit)
	copy(out, l.items[start:])
	return out
}
