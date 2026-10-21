package jsonw

import "testing"

func TestWriter(t *testing.T) {
	var w W
	five := "5.50"
	w.Obj().S("a", "x\"\n台").Key("b").Arr().Int(1).Raw("2.5").Obj().OptN("n", &five).OptS("z", nil).End().EndArr().
		Key("c").Obj().End().Key("d").Bool(true).End()
	want := `{"a":"x\"\n台","b":[1,2.5,{"n":5.5}],"c":{},"d":true}`
	if got := string(w.Bytes()); got != want {
		t.Fatalf("got %s want %s", got, want)
	}
}

func TestTidy(t *testing.T) {
	for in, want := range map[string]string{"11.0000": "11", "12.40": "12.4", "170": "170", "-0.0": "0", "0.05": "0.05", "100": "100"} {
		if got := Tidy(in); got != want {
			t.Errorf("Tidy(%q) = %q, want %q", in, got, want)
		}
	}
}
