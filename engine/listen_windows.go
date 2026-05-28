//go:build windows

package main

import (
	"context"
	"net"
	"syscall"
)

func listenTCP(addr string) (net.Listener, error) {
	lc := net.ListenConfig{
		Control: func(network, address string, c syscall.RawConn) error {
			var ctrlErr error
			if err := c.Control(func(fd uintptr) {
				h := syscall.Handle(fd)
				if e := syscall.SetsockoptInt(h, syscall.SOL_SOCKET, syscall.SO_REUSEADDR, 1); e != nil {
					ctrlErr = e
					return
				}
			}); err != nil {
				return err
			}
			return ctrlErr
		},
	}
	return lc.Listen(context.Background(), "tcp", addr)
}
