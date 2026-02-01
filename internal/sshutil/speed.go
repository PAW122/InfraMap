package sshutil

import (
	"errors"
	"fmt"
	"net"
	"regexp"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"

	"inframap/internal/model"
)

var speedRegex = regexp.MustCompile(`(?i)([0-9]+(?:\.[0-9]+)?)\s*([mg]b/s)`)

func DetectLinkSpeed(settings model.DeviceSettings, timeout time.Duration) (int, string, error) {
	host := strings.TrimSpace(settings.Host)
	if host == "" {
		return 0, "", errors.New("host is empty")
	}
	user := strings.TrimSpace(settings.Username)
	if user == "" {
		return 0, "", errors.New("username is empty")
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
		return 0, "", err
	}

	config := &ssh.ClientConfig{
		User:            user,
		Auth:            auth,
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
	}

	addr := net.JoinHostPort(host, strconv.Itoa(port))
	conn, err := net.DialTimeout("tcp", addr, timeout)
	if err != nil {
		return 0, "", err
	}
	_ = conn.SetDeadline(time.Now().Add(timeout))

	clientConn, chans, reqs, err := ssh.NewClientConn(conn, addr, config)
	if err != nil {
		_ = conn.Close()
		return 0, "", err
	}
	client := ssh.NewClient(clientConn, chans, reqs)
	defer client.Close()

	iface, err := runCommand(client, "sh -c \"ip route get 1.1.1.1 | sed -n 's/.* dev \\([^ ]*\\).*/\\1/p'\"")
	if err != nil {
		return 0, "", fmt.Errorf("failed to detect interface: %w", err)
	}
	iface = strings.TrimSpace(iface)
	if iface == "" {
		fallback, _ := runCommand(client, "sh -c \"ip -o link show | awk -F': ' '$2 != \\\"lo\\\" {print $2; exit}'\"")
		iface = strings.TrimSpace(fallback)
	}
	if iface == "" {
		fallback, _ := runCommand(client, "sh -c \"ls /sys/class/net 2>/dev/null | grep -v '^lo$' | head -n1\"")
		iface = strings.TrimSpace(fallback)
	}
	if iface == "" {
		return 0, "", errors.New("could not determine interface")
	}

	cmd := fmt.Sprintf("sh -c \"ethtool %s 2>/dev/null | awk -F': ' '/Speed:/ {print $2; exit}'\"", iface)
	speedRaw, err := runCommand(client, cmd)
	if err == nil {
		speed, parseErr := parseSpeed(speedRaw)
		if parseErr == nil {
			return speed, iface, nil
		}
	}

	sysRaw, sysErr := runCommand(client, fmt.Sprintf("sh -c \"cat /sys/class/net/%s/speed 2>/dev/null\"", iface))
	if sysErr == nil {
		speed, parseErr := parseSysfsSpeed(sysRaw)
		if parseErr == nil {
			return speed, iface, nil
		}
	}

	return 0, iface, errors.New("speed unavailable (ethtool returned empty and sysfs missing)")
}

func buildAuth(settings model.DeviceSettings) ([]ssh.AuthMethod, error) {
	method := strings.ToLower(strings.TrimSpace(settings.AuthMethod))
	if method == "" {
		method = "password"
	}
	switch method {
	case "ssh_key":
		key := strings.TrimSpace(settings.PrivateKey)
		if key == "" {
			return nil, errors.New("private key is empty")
		}
		var signer ssh.Signer
		var err error
		if settings.PrivateKeyPassphrase != "" {
			signer, err = ssh.ParsePrivateKeyWithPassphrase([]byte(key), []byte(settings.PrivateKeyPassphrase))
		} else {
			signer, err = ssh.ParsePrivateKey([]byte(key))
		}
		if err != nil {
			return nil, err
		}
		return []ssh.AuthMethod{ssh.PublicKeys(signer)}, nil
	default:
		if settings.Password == "" {
			return nil, errors.New("password is empty")
		}
		return []ssh.AuthMethod{ssh.Password(settings.Password)}, nil
	}
}

func runCommand(client *ssh.Client, command string) (string, error) {
	session, err := client.NewSession()
	if err != nil {
		return "", err
	}
	defer session.Close()
	output, err := session.CombinedOutput(command)
	if err != nil {
		return "", err
	}
	return string(output), nil
}

func parseSpeed(raw string) (int, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return 0, errors.New("empty speed")
	}
	if strings.Contains(strings.ToLower(value), "unknown") {
		return 0, errors.New("speed unknown")
	}
	match := speedRegex.FindStringSubmatch(value)
	if len(match) < 3 {
		return 0, fmt.Errorf("unexpected speed format: %s", value)
	}
	num, err := strconv.ParseFloat(match[1], 64)
	if err != nil {
		return 0, err
	}
	unit := strings.ToLower(match[2])
	if strings.HasPrefix(unit, "g") {
		num *= 1000
	}
	if num <= 0 {
		return 0, errors.New("invalid speed")
	}
	return int(num + 0.5), nil
}

func parseSysfsSpeed(raw string) (int, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return 0, errors.New("empty speed")
	}
	if value == "-1" || value == "0" {
		return 0, errors.New("speed unknown")
	}
	num, err := strconv.Atoi(value)
	if err != nil {
		return 0, err
	}
	if num <= 0 {
		return 0, errors.New("invalid speed")
	}
	return num, nil
}
