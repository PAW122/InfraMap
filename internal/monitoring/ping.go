package monitoring

import (
	"context"
	"os/exec"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"

	"inframap/internal/model"
)

var pingRTTRegex = regexp.MustCompile(`time[=<]([0-9.]+)\s*ms`)

func pingTarget(target string) model.PingResult {
	start := time.Now().UTC()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	cmd := buildPingCommand(ctx, target)
	output, err := cmd.CombinedOutput()
	result := model.PingResult{
		Online:      false,
		LastChecked: start,
		RTTMs:       0,
		Target:      target,
	}

	if ctx.Err() == context.DeadlineExceeded {
		result.Error = "timeout"
		return result
	}

	if err == nil {
		result.Online = true
	} else {
		result.Error = "unreachable"
	}

	rtt := parseRTT(string(output))
	if rtt > 0 {
		result.RTTMs = rtt
	}
	return result
}

func parseRTT(output string) int {
	match := pingRTTRegex.FindStringSubmatch(output)
	if len(match) < 2 {
		return 0
	}
	value, err := strconv.ParseFloat(strings.TrimSpace(match[1]), 64)
	if err != nil {
		return 0
	}
	return int(value + 0.5)
}

func buildPingCommand(ctx context.Context, target string) *exec.Cmd {
	switch runtime.GOOS {
	case "windows":
		return exec.CommandContext(ctx, "ping", "-n", "1", "-w", "1000", target)
	case "darwin":
		return exec.CommandContext(ctx, "ping", "-c", "1", "-W", "1000", target)
	case "freebsd", "openbsd", "netbsd":
		return exec.CommandContext(ctx, "ping", "-c", "1", "-W", "1000", target)
	default:
		return exec.CommandContext(ctx, "ping", "-c", "1", "-W", "1", target)
	}
}
