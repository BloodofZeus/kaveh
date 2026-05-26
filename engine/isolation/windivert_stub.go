//go:build !windows

package isolation

import "errors"

type winDivertDiverter struct{}

func newWinDivertDiverter() *winDivertDiverter { return &winDivertDiverter{} }

func (d *winDivertDiverter) StartPID(pid int) (uintptr, func(), error) {
	return 0, func() {}, errors.New("windivert only supported on windows")
}
