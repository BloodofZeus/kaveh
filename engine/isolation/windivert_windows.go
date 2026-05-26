//go:build windows

package isolation

import (
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"syscall"
	"unsafe"
)

type winDivertDiverter struct {
	mu    sync.Mutex
	dll   *syscall.LazyDLL
	open  *syscall.LazyProc
	recv  *syscall.LazyProc
	send  *syscall.LazyProc
	close *syscall.LazyProc
}

func newWinDivertDiverter() *winDivertDiverter {
	return &winDivertDiverter{}
}

func (d *winDivertDiverter) StartPID(pid int) (uintptr, func(), error) {
	if pid <= 0 {
		return 0, func() {}, errors.New("pid must be > 0")
	}

	if err := d.load(); err != nil {
		return 0, func() {}, err
	}

	filter := "outbound and tcp and (processId == " + strconv.Itoa(pid) + ")"
	handle, err := d.winDivertOpen(filter, 3, 0, 0)
	if err != nil {
		return 0, func() {}, err
	}

	stopCh := make(chan struct{})
	go d.pump(handle, stopCh)

	stopFn := func() {
		close(stopCh)
		_ = d.winDivertClose(handle)
	}

	return handle, stopFn, nil
}

func (d *winDivertDiverter) load() error {
	d.mu.Lock()
	defer d.mu.Unlock()

	if d.dll != nil {
		if err := d.dll.Load(); err != nil {
			return err
		}
		return nil
	}

	path, ok := findWinDivertDLL()
	if !ok {
		return errors.New("windivert dll not found")
	}

	d.dll = syscall.NewLazyDLL(path)
	d.open = d.dll.NewProc("WinDivertOpen")
	d.recv = d.dll.NewProc("WinDivertRecv")
	d.send = d.dll.NewProc("WinDivertSend")
	d.close = d.dll.NewProc("WinDivertClose")

	if err := d.dll.Load(); err != nil {
		return err
	}
	if err := d.open.Find(); err != nil {
		return err
	}
	if err := d.recv.Find(); err != nil {
		return err
	}
	if err := d.send.Find(); err != nil {
		return err
	}
	if err := d.close.Find(); err != nil {
		return err
	}
	return nil
}

func findWinDivertDLL() (string, bool) {
	exe, err := os.Executable()
	if err == nil {
		dir := filepath.Dir(exe)
		if fileExists(filepath.Join(dir, "WinDivert64.dll")) {
			return filepath.Join(dir, "WinDivert64.dll"), true
		}
		if fileExists(filepath.Join(dir, "WinDivert.dll")) {
			return filepath.Join(dir, "WinDivert.dll"), true
		}
	}
	if fileExists("WinDivert64.dll") {
		return "WinDivert64.dll", true
	}
	if fileExists("WinDivert.dll") {
		return "WinDivert.dll", true
	}
	return "", false
}

func (d *winDivertDiverter) winDivertOpen(filter string, layer uint32, priority int16, flags uint64) (uintptr, error) {
	b := append([]byte(filter), 0)
	r1, _, e := d.open.Call(
		uintptr(unsafe.Pointer(&b[0])),
		uintptr(layer),
		uintptr(uint16(priority)),
		uintptr(flags),
	)
	if r1 == ^uintptr(0) {
		if e != syscall.Errno(0) {
			return 0, e
		}
		return 0, errors.New("windivert open failed")
	}
	return r1, nil
}

func (d *winDivertDiverter) winDivertClose(handle uintptr) error {
	if handle == 0 || handle == ^uintptr(0) {
		return nil
	}
	r1, _, e := d.close.Call(handle)
	if r1 == 0 {
		if e != syscall.Errno(0) {
			return e
		}
		return errors.New("windivert close failed")
	}
	return nil
}

func (d *winDivertDiverter) pump(handle uintptr, stopCh <-chan struct{}) {
	buf := make([]byte, 0xFFFF)
	addr := make([]byte, 128)
	var recvLen uint32

	for {
		select {
		case <-stopCh:
			return
		default:
		}

		recvLen = 0
		r1, _, _ := d.recv.Call(
			handle,
			uintptr(unsafe.Pointer(&buf[0])),
			uintptr(uint32(len(buf))),
			uintptr(unsafe.Pointer(&recvLen)),
			uintptr(unsafe.Pointer(&addr[0])),
		)
		if r1 == 0 {
			continue
		}
		if recvLen == 0 {
			continue
		}

		var sendLen uint32
		_, _, _ = d.send.Call(
			handle,
			uintptr(unsafe.Pointer(&buf[0])),
			uintptr(recvLen),
			uintptr(unsafe.Pointer(&sendLen)),
			uintptr(unsafe.Pointer(&addr[0])),
		)
	}
}
