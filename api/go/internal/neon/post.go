package neon

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"time"
)

var client = &http.Client{Timeout: 15 * time.Second}

// post is the host build's transport (tests and tools): plain net/http.
func post(ctx context.Context, endpoint string, headers map[string]string, body []byte) (int, []byte, error) {
	req, err := http.NewRequestWithContext(ctx, "POST", endpoint, bytes.NewReader(body))
	if err != nil {
		return 0, nil, err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(res.Body)
	return res.StatusCode, data, err
}
