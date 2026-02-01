package model

import "time"

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
	IPTailscale     string `json:"ipTailscale"`
	IPPublic        string `json:"ipPublic"`
	PingEnabled     *bool  `json:"pingEnabled,omitempty"`
	PingIntervalSec int    `json:"pingIntervalSec,omitempty"`
	ConnectEnabled  bool   `json:"connectEnabled,omitempty"`
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

type SSHStatus struct {
	Online      bool      `json:"online"`
	LastChecked time.Time `json:"lastChecked"`
	Error       string    `json:"error,omitempty"`
}

type DeviceSettings struct {
	OS                   string `json:"os"`
	Host                 string `json:"host"`
	Port                 int    `json:"port"`
	AuthMethod           string `json:"authMethod"`
	Username             string `json:"username"`
	Password             string `json:"password"`
	PrivateKey           string `json:"privateKey"`
	PrivateKeyPassphrase string `json:"privateKeyPassphrase"`
	ConnectEnabled       bool   `json:"connectEnabled"`
	LinkSpeedMbps        int    `json:"linkSpeedMbps"`
}

type LogEntry struct {
	Time    string `json:"time"`
	Level   string `json:"level"`
	Source  string `json:"source"`
	Message string `json:"message"`
}
