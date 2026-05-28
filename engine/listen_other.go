//go:build !windows

package main

import (
	"context"
	"net"
)

func listenTCP(addr string) (net.Listener, error) {
	var lc net.ListenConfig
	return lc.Listen(context.Background(), "tcp", addr)
}

