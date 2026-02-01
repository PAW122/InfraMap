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

func DetectTailscaleIP(settings model.DeviceSettings, timeout time.Duration) (string, error) {
	host := strings.TrimSpace(settings.Host)
	if host == "" {
		return "", errors.New("host is empty")
	}
	user := strings.TrimSpace(settings.Username)
	if user == "" {
		return "", errors.New("username is empty")
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
		return "", err
	}

	config := &ssh.ClientConfig{
		User:            user,
		Auth:            auth,
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
	}

	addr := net.JoinHostPort(host, strconv.Itoa(port))
	conn, err := net.DialTimeout("tcp", addr, timeout)
	if err != nil {
		return "", err
	}
	_ = conn.SetDeadline(time.Now().Add(timeout))

	clientConn, chans, reqs, err := ssh.NewClientConn(conn, addr, config)
	if err != nil {
		_ = conn.Close()
		return "", err
	}
	client := ssh.NewClient(clientConn, chans, reqs)
	defer client.Close()

	ip := findTailscaleIP(client, "tailscale ip -4")
	if ip != "" {
		return ip, nil
	}
	ip = findTailscaleIP(client, "tailscale ip -6")
	if ip != "" {
		return ip, nil
	}
	return "", errors.New("tailscale ip not found")
}

func findTailscaleIP(client *ssh.Client, cmd string) string {
	output, err := runCommand(client, cmd)
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if ip := net.ParseIP(line); ip != nil {
			return ip.String()
		}
	}
	return ""
}
