package sshutil

import (
	"errors"
	"net"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"

	"inframap/internal/model"
)

func CheckConnection(settings model.DeviceSettings, timeout time.Duration) (bool, error) {
	host := strings.TrimSpace(settings.Host)
	if host == "" {
		return false, errors.New("host is empty")
	}
	user := strings.TrimSpace(settings.Username)
	if user == "" {
		return false, errors.New("username is empty")
	}
	port := settings.Port
	if port == 0 {
		port = 22
	}
	if timeout <= 0 {
		timeout = 6 * time.Second
	}
	auth, err := buildAuth(settings)
	if err != nil {
		return false, err
	}

	config := &ssh.ClientConfig{
		User:            user,
		Auth:            auth,
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
	}

	addr := net.JoinHostPort(host, strconv.Itoa(port))
	conn, err := net.DialTimeout("tcp", addr, timeout)
	if err != nil {
		return false, err
	}
	_ = conn.SetDeadline(time.Now().Add(timeout))

	clientConn, chans, reqs, err := ssh.NewClientConn(conn, addr, config)
	if err != nil {
		_ = conn.Close()
		return false, err
	}
	client := ssh.NewClient(clientConn, chans, reqs)
	_ = client.Close()
	return true, nil
}
