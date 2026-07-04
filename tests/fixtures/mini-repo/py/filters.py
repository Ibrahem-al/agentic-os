def smooth(values):
    """Three point moving average used to remove sensor jitter."""
    if len(values) < 3:
        return list(values)
    return [
        (values[i - 1] + values[i] + values[i + 1]) / 3
        for i in range(1, len(values) - 1)
    ]
