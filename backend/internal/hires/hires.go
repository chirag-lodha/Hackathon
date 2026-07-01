// Package hires is the background high-resolution processor.
//
// It decouples enqueueing a job from running it: callers Submit a *HiRes
// (identified by its TrialID) onto a channel; a single dispatcher goroutine
// (started by Init) receives each job and calls execute(), which in turn spins
// up its own goroutine to do the actual model work and update the trial in the
// database. This is the async path the schema already supports (CREATED ->
// PROCESSING -> SUCCESS/FAILURE) — the dispatcher never blocks on model work.
package hires

import (
	"log"

	"lumina/internal/model"
	"lumina/internal/store"
)

// Processor is the HiRes component. It owns the job channel plus the
// dependencies each job needs to process a trial and persist the result.
type Processor struct {
	engine *model.Engine
	repo   *store.Repo
	queue  chan *HiRes
}

// New builds a Processor. Call Init to start the dispatcher goroutine.
func New(engine *model.Engine, repo *store.Repo) *Processor {
	return &Processor{
		engine: engine,
		repo:   repo,
		queue:  make(chan *HiRes, 64), // buffered so Submit rarely blocks
	}
}

// Init starts the dispatcher goroutine that listens on the channel. For each
// received job it injects the shared dependencies and calls execute(), which
// runs the work in its own goroutine so the dispatcher stays responsive.
func (p *Processor) Init() {
	go func() {
		for h := range p.queue {
			h.engine = p.engine
			h.repo = p.repo
			h.execute()
		}
	}()
}

// Submit enqueues a job for background processing.
func (p *Processor) Submit(h *HiRes) {
	p.queue <- h
}

// HiRes is one queued high-resolution job, identified by the trial it processes.
type HiRes struct {
	TrialID uint

	// Injected by the Processor's dispatcher before execute() runs.
	engine *model.Engine
	repo   *store.Repo
}

// execute processes the trial and updates the database. It kicks off the actual
// work in a fresh goroutine so the caller (the dispatcher loop) is never blocked
// by model latency; the goroutine drives the trial through PROCESSING ->
// SUCCESS/FAILURE.
func (h *HiRes) execute() {
	go func() {
		trial, err := h.repo.GetTrial(h.TrialID)
		if err != nil {
			log.Printf("hires: load trial %d: %v", h.TrialID, err)
			return
		}

		_ = h.repo.SetState(trial.ID, store.StateProcessing)
		roi := store.ROIFromCoords(trial.Coords)

		switch trial.Type {
		case "holistic":
			res, err := h.engine.Holistic(trial.FilePath, trial.ESN, roi)
			if err != nil {
				_ = h.repo.Fail(trial.ID, err.Error())
				return
			}
			trial.ResultPath = res.OutputPath
			trial.ResultURL = res.OutputURL
			trial.Sources = store.MarshalSources(res.Sources)
			trial.DurationMS = res.MS
		default: // "super_res"
			res, err := h.engine.SuperResolve(trial.FilePath, roi)
			if err != nil {
				_ = h.repo.Fail(trial.ID, err.Error())
				return
			}
			trial.ResultPath = res.OutputPath
			trial.ResultURL = res.OutputURL
			trial.SourceURL = res.SourceURL
			trial.Scale = res.Scale
			trial.DurationMS = res.MS
		}

		if err := h.repo.Complete(trial); err != nil {
			log.Printf("hires: complete trial %d: %v", trial.ID, err)
		}
	}()
}
