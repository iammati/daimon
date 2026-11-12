/// Emits OSC 133 command start mark.
pub fn run() -> anyhow::Result<()> {
    print!("\x1b]133;C\x1b\\");
    Ok(())
}
