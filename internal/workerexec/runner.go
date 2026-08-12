package workerexec

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
)

const outputChunkSize = 8 << 10

type Output struct {
	Stream string
	Text   string
}

type Runner interface {
	Run(context.Context, Command, func(Output) error) error
}

type OSRunner struct{}

func (OSRunner) Run(
	ctx context.Context,
	command Command,
	emit func(Output) error,
) error {
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	cmd := exec.CommandContext(runCtx, command.Path, command.Args...)
	cmd.Dir = command.Dir
	cmd.Env = mergedEnvironment(command.Env)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start coding agent: %w", err)
	}

	var wg sync.WaitGroup
	var emitErr error
	var emitMu sync.Mutex
	stream := func(name string, reader io.Reader) {
		defer wg.Done()
		buffer := make([]byte, outputChunkSize)
		for {
			n, readErr := reader.Read(buffer)
			if n > 0 {
				emitMu.Lock()
				if emitErr == nil {
					emitErr = emit(Output{Stream: name, Text: string(buffer[:n])})
					if emitErr != nil {
						cancel()
					}
				}
				emitMu.Unlock()
			}
			if readErr != nil {
				if !errors.Is(readErr, io.EOF) {
					emitMu.Lock()
					if emitErr == nil {
						emitErr = readErr
					}
					emitMu.Unlock()
				}
				return
			}
		}
	}
	wg.Add(2)
	go stream("stdout", stdout)
	go stream("stderr", stderr)
	waitErr := cmd.Wait()
	wg.Wait()
	if emitErr != nil {
		return fmt.Errorf("publish coding-agent output: %w", emitErr)
	}
	if waitErr != nil {
		return fmt.Errorf("coding agent exited: %w", waitErr)
	}
	return nil
}

func mergedEnvironment(overrides map[string]string) []string {
	values := make(map[string]string)
	for _, entry := range os.Environ() {
		for i := 0; i < len(entry); i++ {
			if entry[i] == '=' {
				values[entry[:i]] = entry[i+1:]
				break
			}
		}
	}
	for key, value := range overrides {
		values[key] = value
	}
	environment := make([]string, 0, len(values))
	for key, value := range values {
		environment = append(environment, key+"="+value)
	}
	return environment
}
