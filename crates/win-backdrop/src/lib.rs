//! Desktop blur with a freely adjustable radius behind a window, for the daimon shell
//! on Windows.
//!
//! DWM's own backdrops (blur-behind / acrylic / mica) have a fixed look. The
//! composition API lets a visual sample whatever is behind it (`CreateBackdropBrush`);
//! under a transparent window that is the desktop itself, which we run through our own
//! Gaussian blur. The visual is attached *below* the window's child windows, so the
//! transparent WebView2 draws on top of it.
//!
//! Loaded from the main process with `bun:ffi`; see app/src/bun/winBackdrop.ts.
#![cfg(windows)]

use std::cell::RefCell;
use std::sync::Mutex;

use windows::core::{implement, Interface, Result, GUID, HSTRING, PCWSTR};
use windows_numerics::Vector2;
use windows::Foundation::{IPropertyValue, PropertyValue};
use windows::Graphics::Effects::{IGraphicsEffect, IGraphicsEffectSource, IGraphicsEffectSource_Impl, IGraphicsEffect_Impl};
use windows::System::DispatcherQueueController;
use windows::UI::Composition::Desktop::DesktopWindowTarget;
use windows::UI::Composition::{CompositionBrush, CompositionEffectSourceParameter, Compositor, SpriteVisual};
use windows::Win32::Foundation::{E_BOUNDS, E_FAIL, E_INVALIDARG, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::WinRT::Composition::ICompositorDesktopInterop;
use windows::Win32::System::WinRT::Graphics::Direct2D::{
    IGraphicsEffectD2D1Interop, IGraphicsEffectD2D1Interop_Impl, GRAPHICS_EFFECT_PROPERTY_MAPPING,
    GRAPHICS_EFFECT_PROPERTY_MAPPING_DIRECT,
};
use windows::Win32::System::WinRT::{
    CreateDispatcherQueueController, DispatcherQueueOptions, DQTAT_COM_NONE, DQTYPE_THREAD_CURRENT,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetWindowThreadProcessId, IsWindow, RegisterWindowMessageW, SendMessageW, SetWindowsHookExW,
    UnhookWindowsHookEx, CWPSTRUCT, WH_CALLWNDPROC,
};

// ── Gaussian blur effect description ──────────────────────────────────────────
// The compositor asks this object which D2D effect to build and with what settings.

/// CLSID_D2D1GaussianBlur
const GAUSSIAN_BLUR: GUID = GUID::from_u128(0x1feb6d69_2fe6_4ac9_8c58_1d7f93e7a6a5);
const SOURCE_NAME: &str = "backdrop";

#[implement(IGraphicsEffect, IGraphicsEffectSource, IGraphicsEffectD2D1Interop)]
struct BlurEffect {
    /// Standard deviation in DIPs.
    amount: f32,
    source: CompositionEffectSourceParameter,
}

impl IGraphicsEffect_Impl for BlurEffect_Impl {
    fn Name(&self) -> Result<HSTRING> {
        Ok(HSTRING::from("Blur"))
    }
    fn SetName(&self, _name: &HSTRING) -> Result<()> {
        Ok(())
    }
}

impl IGraphicsEffectSource_Impl for BlurEffect_Impl {}

impl IGraphicsEffectD2D1Interop_Impl for BlurEffect_Impl {
    fn GetEffectId(&self) -> Result<GUID> {
        Ok(GAUSSIAN_BLUR)
    }
    fn GetNamedPropertyMapping(
        &self,
        _name: &PCWSTR,
        index: *mut u32,
        mapping: *mut GRAPHICS_EFFECT_PROPERTY_MAPPING,
    ) -> Result<()> {
        // Only "BlurAmount" is ever animated, and we don't animate at all.
        unsafe {
            *index = 0;
            *mapping = GRAPHICS_EFFECT_PROPERTY_MAPPING_DIRECT;
        }
        Ok(())
    }
    fn GetPropertyCount(&self) -> Result<u32> {
        Ok(3)
    }
    fn GetProperty(&self, index: u32) -> Result<IPropertyValue> {
        let value = match index {
            0 => PropertyValue::CreateSingle(self.amount)?, // D2D1_GAUSSIANBLUR_PROP_STANDARD_DEVIATION
            1 => PropertyValue::CreateUInt32(1)?,           // optimization: balanced
            2 => PropertyValue::CreateUInt32(1)?,           // border mode: hard (no dark fringe at the edges)
            _ => return Err(E_BOUNDS.into()),
        };
        value.cast()
    }
    fn GetSource(&self, index: u32) -> Result<IGraphicsEffectSource> {
        if index == 0 { self.source.cast() } else { Err(E_BOUNDS.into()) }
    }
    fn GetSourceCount(&self) -> Result<u32> {
        Ok(1)
    }
}

// ── Per-window state (lives on, and is only touched from, the window's thread) ──

struct Backdrop {
    compositor: Compositor,
    _target: DesktopWindowTarget,
    visual: SpriteVisual,
    /// Extra blur of the current brush; negative until the first brush is made.
    amount: f32,
}

thread_local! {
    static BACKDROP: RefCell<Option<Backdrop>> = const { RefCell::new(None) };
    static QUEUE: RefCell<Option<DispatcherQueueController>> = const { RefCell::new(None) };
}

fn blur_brush(compositor: &Compositor, amount: f32) -> Result<CompositionBrush> {
    let source = CompositionEffectSourceParameter::Create(&HSTRING::from(SOURCE_NAME))?;
    let effect: IGraphicsEffect = BlurEffect { amount, source }.into();
    let brush = compositor.CreateEffectFactory(&effect)?.CreateBrush()?;
    // CreateBackdropBrush, not CreateHostBackdropBrush: the host variant is delivered
    // already blurred by a fixed amount, this one is the sharp content behind the visual.
    brush.SetSourceParameter(&HSTRING::from(SOURCE_NAME), &compositor.CreateBackdropBrush()?)?;
    brush.cast()
}

fn attach(hwnd: HWND) -> Result<()> {
    // The compositor needs a dispatcher queue on its thread. One may already exist.
    QUEUE.with(|q| {
        if q.borrow().is_none() {
            let options = DispatcherQueueOptions {
                dwSize: std::mem::size_of::<DispatcherQueueOptions>() as u32,
                threadType: DQTYPE_THREAD_CURRENT,
                apartmentType: DQTAT_COM_NONE,
            };
            if let Ok(controller) = unsafe { CreateDispatcherQueueController(options) } {
                *q.borrow_mut() = Some(controller);
            }
        }
    });

    let compositor = Compositor::new()?;
    let interop: ICompositorDesktopInterop = compositor.cast()?;
    // isTopmost = false → below the window's child windows (the WebView2).
    let target = unsafe { interop.CreateDesktopWindowTarget(hwnd, false)? };

    let visual = compositor.CreateSpriteVisual()?;
    visual.SetRelativeSizeAdjustment(Vector2 { X: 1.0, Y: 1.0 })?;
    visual.SetIsVisible(false)?;
    target.SetRoot(&visual)?;

    BACKDROP.with(|b| *b.borrow_mut() = Some(Backdrop { compositor, _target: target, visual, amount: -1.0 }));
    Ok(())
}

fn set_blur(strength: f32, extra: f32) -> Result<()> {
    BACKDROP.with(|b| {
        let mut slot = b.borrow_mut();
        let state = slot.as_mut().ok_or(E_FAIL)?;
        let strength = strength.clamp(0.0, 1.0);
        let extra = extra.max(0.0);
        if strength <= 0.0 {
            state.visual.SetIsVisible(false)?;
            return Ok(());
        }
        if extra != state.amount || state.visual.Brush().is_err() {
            state.visual.SetBrush(&blur_brush(&state.compositor, extra)?)?;
            state.amount = extra;
        }
        state.visual.SetOpacity(strength)?;
        state.visual.SetIsVisible(true)?;
        Ok(())
    })
}

// ── Running on the window's thread ────────────────────────────────────────────
// Composition targets belong to the thread that owns the window, and our caller is a
// different thread. A one-shot CallWndProc hook plus a synchronous SendMessage runs
// the job over there without touching the window procedure.

type Job = Box<dyn FnOnce() -> Result<()> + Send>;
static PENDING: Mutex<Option<(Job, Option<Result<()>>)>> = Mutex::new(None);
static CALL: Mutex<()> = Mutex::new(());

fn job_message() -> u32 {
    unsafe { RegisterWindowMessageW(windows::core::w!("daimon.win-backdrop.job")) }
}

unsafe extern "system" fn hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let cwp = &*(lparam.0 as *const CWPSTRUCT);
        if cwp.message == job_message() {
            let job = PENDING.lock().ok().and_then(|mut p| p.as_mut().and_then(|(_, done)| if done.is_none() { Some(()) } else { None }).and(p.take()));
            if let Some((job, _)) = job {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(job)).unwrap_or(Err(E_FAIL.into()));
                if let Ok(mut p) = PENDING.lock() {
                    *p = Some((Box::new(|| Ok(())), Some(result)));
                }
            }
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

fn on_window_thread(hwnd: HWND, job: Job) -> Result<()> {
    let _serial = CALL.lock().map_err(|_| E_FAIL)?;
    unsafe {
        if !IsWindow(Some(hwnd)).as_bool() {
            return Err(E_INVALIDARG.into());
        }
        let thread = GetWindowThreadProcessId(hwnd, None);
        *PENDING.lock().map_err(|_| E_FAIL)? = Some((job, None));
        let hook = SetWindowsHookExW(WH_CALLWNDPROC, Some(hook), None, thread)?;
        SendMessageW(hwnd, job_message(), None, None);
        let _ = UnhookWindowsHookEx(hook);
        match PENDING.lock().map_err(|_| E_FAIL)?.take() {
            Some((_, Some(result))) => result,
            _ => Err(E_FAIL.into()),
        }
    }
}

// ── C ABI ─────────────────────────────────────────────────────────────────────
// Both return 0 on success, otherwise the failing HRESULT.

fn code(result: Result<()>) -> i32 {
    match result {
        Ok(()) => 0,
        Err(e) if e.code().0 != 0 => e.code().0,
        Err(_) => E_FAIL.0,
    }
}

/// Attach the blur layer to a top-level window. Call once per window.
#[no_mangle]
pub extern "C" fn daimon_backdrop_attach(hwnd: *mut core::ffi::c_void) -> i32 {
    let raw = hwnd as usize; // raw pointers aren't Send; the handle is just a number
    code(on_window_thread(HWND(hwnd), Box::new(move || attach(HWND(raw as *mut _)))))
}

/// Set how blurred the desktop behind the window looks.
/// - `strength` 0..1 — opacity of the blurred layer (0 = off, plain see-through)
/// - `extra` — blur radius: Gaussian standard deviation, in DIPs
#[no_mangle]
pub extern "C" fn daimon_backdrop_set_blur(hwnd: *mut core::ffi::c_void, strength: f32, extra: f32) -> i32 {
    code(on_window_thread(HWND(hwnd), Box::new(move || set_blur(strength, extra))))
}
